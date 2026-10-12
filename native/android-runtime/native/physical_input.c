#define _GNU_SOURCE
#include <jni.h>
#include <linux/input.h>
#include <sys/ioctl.h>
#include <sys/inotify.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <stdint.h>
#include <poll.h>
#include <pthread.h>
#include <stdatomic.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <errno.h>
#include <limits.h>

#define FN(n) Java_dev_lecturn_broker_PhysicalInput_##n
#define MAX_DEVICES 128
#define BITS(n) (((n)+7)/8)
#define BIT(a,n) (((a)[(n)/8] >> ((n)%8)) & 1)
struct detector { int fd; int slots; };
struct monitor {
    JavaVM *vm; jobject callback; jmethodID changed; pthread_t thread;
    struct detector devices[MAX_DEVICES]; int count, notify, wake[2];
    atomic_int healthy, stopping, initialized;
    atomic_llong heartbeat, last_input;
};
static long long now_ms(void) { struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return (long long)t.tv_sec*1000+t.tv_nsec/1000000; }
// EVIOCGKEY includes touch buttons. MT tracking IDs cover touches on devices with no BTN_TOUCH.
static int idle(struct monitor *m) {
    for(int i=0;i<m->count;i++) {
        unsigned char keys[BITS(KEY_CNT)]={0};
        if(ioctl(m->devices[i].fd,EVIOCGKEY(sizeof(keys)),keys)<0) { atomic_store(&m->healthy,0);return 0; }
        for(size_t j=0;j<sizeof(keys);j++) if(keys[j]) return 0;
        int slots=m->devices[i].slots;
        if(slots) {
            int values[65]; values[0]=ABS_MT_TRACKING_ID;
            if(ioctl(m->devices[i].fd,EVIOCGMTSLOTS((slots+1)*sizeof(int)),values)<0) { atomic_store(&m->healthy,0);return 0; }
            for(int j=1;j<=slots;j++) if(values[j]>=0) return 0;
        }
    }
    return 1;
}
static void *watch(void *arg) {
    struct monitor *m=arg;JNIEnv *e=NULL;
    if((*m->vm)->AttachCurrentThread(m->vm,&e,NULL)!=JNI_OK) { atomic_store(&m->healthy,0);return NULL; }
    atomic_store(&m->initialized,1);
    struct pollfd fds[MAX_DEVICES+2];
    for(int i=0;i<m->count;i++) fds[i]=(struct pollfd){.fd=m->devices[i].fd,.events=POLLIN};
    fds[m->count]=(struct pollfd){.fd=m->notify,.events=POLLIN};
    fds[m->count+1]=(struct pollfd){.fd=m->wake[0],.events=POLLIN};
    while(!atomic_load(&m->stopping)) {
        int n=poll(fds,(nfds_t)m->count+2,20), changed=0, failed=0;
        if(n<0 && errno==EINTR) continue;
        if(n<0 || fds[m->count].revents || !atomic_load(&m->healthy)) failed=1; // topology change requires a fresh broker qualification
        for(int i=0;i<m->count && !failed;i++) {
            if(fds[i].revents & (POLLERR|POLLHUP|POLLNVAL)) { failed=1;break; }
            if(!(fds[i].revents&POLLIN)) continue;
            // Bounded drain: continuous activity must not starve revoke or watchdog health.
            struct input_event events[64];
            ssize_t bytes=read(fds[i].fd,events,sizeof(events));
            if(bytes<0 && (errno==EAGAIN || errno==EINTR)) continue;
            if(bytes<=0 || bytes%(ssize_t)sizeof(events[0])) { failed=1;break; }
            for(size_t j=0;j<(size_t)bytes/sizeof(events[0]);j++) {
                if(events[j].type==EV_SYN && events[j].code==SYN_DROPPED) failed=1;
                if(events[j].type==EV_KEY || events[j].type==EV_ABS || events[j].type==EV_REL) changed=1;
            }
            memset(events,0,sizeof(events)); // no content retained or logged
        }
        atomic_store(&m->heartbeat,now_ms());
        if(changed) atomic_store(&m->last_input,now_ms());
        if(failed) atomic_store(&m->healthy,0);
        if(changed || failed) {
            (*e)->CallVoidMethod(e,m->callback,m->changed);
            if((*e)->ExceptionCheck(e)) { (*e)->ExceptionClear(e);atomic_store(&m->healthy,0);failed=1; }
        }
        if(failed) break;
    }
    atomic_store(&m->healthy,0);(*m->vm)->DetachCurrentThread(m->vm);return NULL;
}
static void cleanup(JNIEnv *e,struct monitor *m) {
    for(int i=0;i<m->count;i++) close(m->devices[i].fd);
    if(m->notify>=0) close(m->notify);
    if(m->wake[0]>=0) close(m->wake[0]);
    if(m->wake[1]>=0) close(m->wake[1]);
    if(m->callback) (*e)->DeleteGlobalRef(e,m->callback);
    free(m);
}
JNIEXPORT jlong JNICALL FN(start)(JNIEnv *e,jclass c,jobject callback) {
    (void)c;struct monitor *m=calloc(1,sizeof(*m));if(!m) return 0;
    m->notify=-1;m->wake[0]=m->wake[1]=-1;
    m->notify=inotify_init1(IN_CLOEXEC|IN_NONBLOCK);
    if(m->notify<0 || inotify_add_watch(m->notify,"/dev/input",IN_CREATE|IN_DELETE|IN_MOVED_FROM|IN_MOVED_TO|IN_ATTRIB|IN_DELETE_SELF|IN_MOVE_SELF)<0) goto bad;
    DIR *dir=opendir("/dev/input");if(!dir) goto bad;
    struct dirent *entry;int touch=0,key=0,failed=0;
    for(;;) {
        errno=0;entry=readdir(dir);
        if(!entry) { if(errno)failed=1;break; }
        if(strncmp(entry->d_name,"event",5)) continue;
        const char *suffix=entry->d_name+5;
        if(!*suffix || strspn(suffix,"0123456789")!=strlen(suffix)) { failed=1;break; }
        char path[512];snprintf(path,sizeof(path),"/dev/input/%s",entry->d_name);
        int fd=open(path,O_RDONLY|O_NONBLOCK|O_CLOEXEC|O_NOFOLLOW);
        if(fd<0) { failed=1;break; } // cannot prove an unreadable node isn't a detector
        struct stat st;struct input_id id;char sys[128],resolved[PATH_MAX];
        unsigned char ev[BITS(EV_CNT)]={0},keys[BITS(KEY_CNT)]={0},abs[BITS(ABS_CNT)]={0},props[BITS(INPUT_PROP_CNT)]={0};
        if(fstat(fd,&st) || !S_ISCHR(st.st_mode) || ioctl(fd,EVIOCGID,&id)<0 || ioctl(fd,EVIOCGBIT(0,sizeof(ev)),ev)<0) { close(fd);failed=1;break; }
        snprintf(sys,sizeof(sys),"/sys/dev/char/%u:%u/device",major(st.st_rdev),minor(st.st_rdev));
        if(!realpath(sys,resolved)) { close(fd);failed=1;break; }
        // Framework injection has no evdev node. Exclude uinput/virtual sources explicitly.
        if(strstr(resolved,"/devices/virtual/") || id.bustype==BUS_VIRTUAL) { close(fd);continue; }
        if(!BIT(ev,EV_KEY) && !BIT(ev,EV_ABS)) { close(fd);continue; }
        if(ioctl(fd,EVIOCGBIT(EV_KEY,sizeof(keys)),keys)<0) { close(fd);failed=1;break; }
        int is_touch=0,is_key=0,slots=0;
        if(BIT(ev,EV_ABS)) {
            if(ioctl(fd,EVIOCGBIT(EV_ABS,sizeof(abs)),abs)<0 || ioctl(fd,EVIOCGPROP(sizeof(props)),props)<0) { close(fd);failed=1;break; }
            is_touch=BIT(props,INPUT_PROP_DIRECT) && ((BIT(abs,ABS_MT_POSITION_X)&&BIT(abs,ABS_MT_POSITION_Y)) || (BIT(abs,ABS_X)&&BIT(abs,ABS_Y)&&BIT(keys,BTN_TOUCH)));
            if(is_touch && BIT(abs,ABS_MT_SLOT)) {
                struct input_absinfo info;
                if(!BIT(abs,ABS_MT_TRACKING_ID) || ioctl(fd,EVIOCGABS(ABS_MT_SLOT),&info)<0 || info.minimum!=0 || info.maximum<0 || info.maximum>=64) { close(fd);failed=1;break; }
                slots=info.maximum+1;
            } else if(is_touch && !BIT(keys,BTN_TOUCH)) { close(fd);failed=1;break; }
        }
        for(int k=1;k<BTN_MISC;k++) if(BIT(keys,k)) is_key=1;
        if(!is_touch && !is_key && !BIT(ev,EV_REL)) { close(fd);continue; }
        if(m->count==MAX_DEVICES) { close(fd);failed=1;break; }
        m->devices[m->count++]=(struct detector){fd,slots};touch|=is_touch;key|=is_key;
    }
    closedir(dir);
    if(failed || !touch || !key || pipe2(m->wake,O_CLOEXEC|O_NONBLOCK)) goto bad;
    if((*e)->GetJavaVM(e,&m->vm)!=JNI_OK) goto bad;
    m->callback=(*e)->NewGlobalRef(e,callback);
    jclass cls=(*e)->GetObjectClass(e,callback);m->changed=(*e)->GetMethodID(e,cls,"changed","()V");(*e)->DeleteLocalRef(e,cls);
    if(!m->callback || !m->changed) goto bad;
    atomic_store(&m->heartbeat,now_ms());atomic_store(&m->healthy,1);
    if(pthread_create(&m->thread,NULL,watch,m)) goto bad;
    return (jlong)(intptr_t)m;
bad: cleanup(e,m);return 0;
}
JNIEXPORT jboolean JNICALL FN(ready)(JNIEnv *e,jclass c,jlong handle) {
    (void)e;(void)c;struct monitor *m=(struct monitor *)(intptr_t)handle;
    if(!m || !atomic_load(&m->initialized) || !atomic_load(&m->healthy) || now_ms()-atomic_load(&m->heartbeat)>=250 || now_ms()-atomic_load(&m->last_input)<500) return JNI_FALSE;
    struct pollfd fds[MAX_DEVICES+1];
    for(int i=0;i<m->count;i++) fds[i]=(struct pollfd){.fd=m->devices[i].fd,.events=POLLIN};
    fds[m->count]=(struct pollfd){.fd=m->notify,.events=POLLIN};
    // Pending physical events/topology changes cannot be overtaken by a lease.
    if(poll(fds,(nfds_t)m->count+1,0)!=0) return JNI_FALSE;
    return idle(m) ? JNI_TRUE : JNI_FALSE;
}
JNIEXPORT void JNICALL FN(stop)(JNIEnv *e,jclass c,jlong handle) {
    (void)c;struct monitor *m=(struct monitor *)(intptr_t)handle;if(!m)return;
    atomic_store(&m->stopping,1);char b=0;ssize_t ignored=write(m->wake[1],&b,1);(void)ignored;
    pthread_join(m->thread,NULL);cleanup(e,m);
}
