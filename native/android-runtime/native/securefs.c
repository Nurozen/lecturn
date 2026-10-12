#define _GNU_SOURCE
#include <jni.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <sys/xattr.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <linux/openat2.h>
#include "securefs_paths.h"

#define MAX_FILE (256 * 1024)
#define JNI_FN(name) Java_dev_lecturn_broker_SecureFiles_##name
static void fail(JNIEnv *e) {
    jclass c = (*e)->FindClass(e, "java/io/IOException");
    if (c) (*e)->ThrowNew(e, c, "secure_file_operation_refused");
}
static int beneath(int dir, const char *p, int flags, mode_t mode) {
    struct open_how how = {.flags = (uint64_t)(flags | O_CLOEXEC | O_NOFOLLOW), .mode = mode,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS};
    return (int)syscall(__NR_openat2, dir, p, &how, sizeof(how));
}
static int absolute(const char *p, int flags) {
    if (!p || p[0] != '/' || p[1] == '\0') return -1;
    int base = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (base < 0) return -1;
    int fd = beneath(base, p + 1, flags, 0);
    close(base); return fd;
}
static char *utf(JNIEnv *e, jstring s) {
    if (!s) return NULL;
    jsize count = (*e)->GetStringLength(e,s);
    const jchar *v = (*e)->GetStringChars(e,s,NULL);
    if (!v) return NULL;
    char *out = malloc((size_t)count * 3 + 1);
    if (!out) { (*e)->ReleaseStringChars(e,s,v); return NULL; }
    size_t n=0;
    for (jsize i=0;i<count;i++) {
        uint32_t cp=v[i];
        if (cp >= 0xd800 && cp <= 0xdbff && i+1<count && v[i+1]>=0xdc00 && v[i+1]<=0xdfff) {
            cp=0x10000+((cp-0xd800)<<10)+(v[++i]-0xdc00);
        } else if (!cp || (cp>=0xd800 && cp<=0xdfff)) {
            free(out); (*e)->ReleaseStringChars(e,s,v); return NULL;
        }
        if (cp<0x80) out[n++]=(char)cp;
        else if (cp<0x800) { out[n++]=(char)(0xc0|(cp>>6)); out[n++]=(char)(0x80|(cp&63)); }
        else if (cp<0x10000) { out[n++]=(char)(0xe0|(cp>>12)); out[n++]=(char)(0x80|((cp>>6)&63)); out[n++]=(char)(0x80|(cp&63)); }
        else { out[n++]=(char)(0xf0|(cp>>18)); out[n++]=(char)(0x80|((cp>>12)&63)); out[n++]=(char)(0x80|((cp>>6)&63)); out[n++]=(char)(0x80|(cp&63)); }
    }
    out[n]='\0'; (*e)->ReleaseStringChars(e,s,v); return out;
}
static jstring filename(JNIEnv *e, const char *name) {
    jclass string = (*e)->FindClass(e,"java/lang/String");
    jmethodID constructor = (*e)->GetMethodID(e,string,"<init>","([BLjava/lang/String;)V");
    size_t len=strlen(name);
    jbyteArray data=(*e)->NewByteArray(e,(jsize)len);
    if (!data) return NULL;
    (*e)->SetByteArrayRegion(e,data,0,(jsize)len,(const jbyte *)name);
    jstring charset=(*e)->NewStringUTF(e,"UTF-8");
    jstring result=(jstring)(*e)->NewObject(e,string,constructor,data,charset);
    (*e)->DeleteLocalRef(e,data); (*e)->DeleteLocalRef(e,charset); (*e)->DeleteLocalRef(e,string);
    return result;
}
static jbyteArray bytes(JNIEnv *e, int fd, int max) {
    struct stat st;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_size < 0 || st.st_size > max) { fail(e); return NULL; }
    unsigned char *b = malloc((size_t)max + 1);
    if (!b) { fail(e); return NULL; }
    size_t used = 0;
    while (used <= (size_t)max) {
        ssize_t n = read(fd, b + used, (size_t)max + 1 - used);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) { free(b); fail(e); return NULL; }
        if (!n) break;
        used += (size_t)n;
    }
    if (used > (size_t)max) { free(b); fail(e); return NULL; }
    jbyteArray out = (*e)->NewByteArray(e, (jsize)used);
    if (out) (*e)->SetByteArrayRegion(e, out, 0, (jsize)used, (jbyte *)b);
    free(b); return out;
}
JNIEXPORT jboolean JNICALL JNI_FN(supported)(JNIEnv *e, jclass c) {
    (void)e; (void)c;
    int fd = absolute("/data", O_PATH | O_DIRECTORY);
    if (fd < 0) return JNI_FALSE;
    close(fd); return JNI_TRUE;
}
JNIEXPORT jbyteArray JNICALL JNI_FN(privateFile)(JNIEnv *e, jclass c, jstring path, jint max, jint uid) {
    (void)c;
    char *p = utf(e, path);
    if (!p || max < 1 || max > 65536) { free(p); fail(e); return NULL; }
    int fd = absolute(p, O_RDONLY | O_NONBLOCK); free(p);
    struct stat st;
    if (fd < 0 || fstat(fd, &st) || st.st_uid != (uid_t)uid || (st.st_mode & 0077)) {
        if (fd >= 0) close(fd);
        fail(e); return NULL;
    }
    jbyteArray out = bytes(e, fd, max); close(fd); return out;
}
static int package_dir(const char *root, const char *pkg) {
    if (public_root(root) && pkg && !*pkg)
        return absolute(!strcmp(root,"storage") ? "/data/media/0"
            : !strcmp(root,"downloads") ? "/data/media/0/Download" : "/data/media/0/Documents", O_RDONLY | O_DIRECTORY);
    if (!pkg || !*pkg || strlen(pkg) > 200 || !strcmp(pkg, "com.cloudgatherer.lecturn.symba")
        || !strcmp(pkg, "com.android.keychain")) return -1;
    for (const char *p = pkg; *p; p++) if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || *p == '_' || *p == '.')) return -1;
    if (!relative(pkg, 0) || !strcmp(pkg, ".") || !strcmp(pkg, "..")) return -1;
    const char *base = !strcmp(root,"ce") ? "/data/data" : !strcmp(root,"de") ? "/data/user_de/0"
        : !strcmp(root,"shared") ? "/data/media/0/Android/data" : !strcmp(root,"media") ? "/data/media/0/Android/media"
        : !strcmp(root,"obb") ? "/data/media/0/Android/obb" : NULL;
    if (!base) return -1;
    int fd = absolute(base, O_PATH | O_DIRECTORY);
    if (fd < 0) return -1;
    int out = beneath(fd, pkg, O_RDONLY | O_DIRECTORY, 0); close(fd);
    return out;
}
static int target(JNIEnv *e, jstring root, jstring pkg, jstring path, char **p) {
    char *r = utf(e, root), *k = utf(e, pkg); *p = utf(e, path);
    int fd = r && k && target_path(r, *p) ? package_dir(r,k) : -1;
    free(r); free(k); return fd;
}
JNIEXPORT jobject JNICALL JNI_FN(read)(JNIEnv *e, jclass c, jstring root, jstring pkg, jstring path, jlong offset, jint length) {
    (void)c; char *p = NULL;
    if(offset<0 || offset>INT64_MAX-MAX_FILE || length<1 || length>MAX_FILE) { fail(e);return NULL; }
    int base = target(e,root,pkg,path,&p);
    int fd = base >= 0 && p && *p ? beneath(base,p,O_RDONLY | O_NONBLOCK,0) : -1;
    if (base >= 0) close(base);
    free(p);
    if (fd < 0) { fail(e); return NULL; }
    struct stat before,after;
    unsigned char *buf=NULL; jobject out=NULL;
    if(fstat(fd,&before) || !S_ISREG(before.st_mode) || before.st_nlink!=1 || before.st_size<0) goto bad_read;
    size_t wanted=offset>=before.st_size?0:(size_t)((before.st_size-offset)<length?(before.st_size-offset):length);
    buf=malloc(wanted+1);if(!buf) goto bad_read;
    size_t used=0;
    while(used<wanted) {
        ssize_t n=pread(fd,buf+used,wanted-used,(off_t)offset+(off_t)used);
        if(n<0 && errno==EINTR) continue;
        if(n<=0) goto bad_read;
        used+=(size_t)n;
    }
    // Data and total size refer to the same opened inode. Detect concurrent mutation,
    // including hardlink addition; chunked calls are not a cross-call snapshot.
    if(fstat(fd,&after) || after.st_nlink!=1 || after.st_size!=before.st_size ||
       after.st_mtim.tv_sec!=before.st_mtim.tv_sec || after.st_mtim.tv_nsec!=before.st_mtim.tv_nsec ||
       after.st_ctim.tv_sec!=before.st_ctim.tv_sec || after.st_ctim.tv_nsec!=before.st_ctim.tv_nsec) goto bad_read;
    jclass cls=(*e)->FindClass(e,"dev/lecturn/broker/SecureFiles$Chunk");
    if(!cls) goto bad_read;
    jmethodID ctor=(*e)->GetMethodID(e,cls,"<init>","([BJ)V");
    jbyteArray data=(*e)->NewByteArray(e,(jsize)used);
    if(data && ctor) {
        (*e)->SetByteArrayRegion(e,data,0,(jsize)used,(const jbyte *)buf);
        out=(*e)->NewObject(e,cls,ctor,data,(jlong)before.st_size);
    }
    if(data) (*e)->DeleteLocalRef(e,data);
    (*e)->DeleteLocalRef(e,cls);
    free(buf);close(fd);return out;
bad_read:
    free(buf);close(fd);if(!(*e)->ExceptionCheck(e))fail(e);return NULL;
}
JNIEXPORT jobjectArray JNICALL JNI_FN(list)(JNIEnv *e, jclass c, jstring root, jstring pkg, jstring path) {
    (void)c; char *p = NULL;
    int base = target(e,root,pkg,path,&p);
    int fd = base < 0 ? -1 : !*p ? dup(base) : beneath(base,p,O_RDONLY | O_DIRECTORY,0);
    if (base >= 0) close(base);
    free(p);
    if (fd < 0) { fail(e); return NULL; }
    DIR *d = fdopendir(fd);
    if (!d) { close(fd); fail(e); return NULL; }
    char *names[512]; size_t count = 0; struct dirent *entry;
    int error = 0;
    errno = 0;
    while ((entry = readdir(d))) {
        if (!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..")) continue;
        if (count == 512) { error = 1; break; }
        names[count] = strdup(entry->d_name);
        if (!names[count]) { error = 1; break; }
        count++;
    }
    if (errno) error = 1;
    closedir(d);
    jobjectArray out = NULL;
    if (!error) out = (*e)->NewObjectArray(e,(jsize)count,(*e)->FindClass(e,"java/lang/String"),NULL);
    for (size_t i=0;i<count;i++) {
        if (out) { jstring s = filename(e,names[i]); (*e)->SetObjectArrayElement(e,out,(jsize)i,s); (*e)->DeleteLocalRef(e,s); }
        free(names[i]);
    }
    if (error) fail(e);
    return out;
}
struct staged { int parent; char *name; char temp[64]; struct stat original; int existed; };
static int parent_at(int base, char *p, char **name) {
    if (!relative(p,0)) return -1;
    char *slash = strrchr(p,'/');
    if (!slash) { *name = p; return dup(base); }
    *slash = '\0'; *name = slash+1;
    return beneath(base,p,O_RDONLY | O_DIRECTORY,0);
}
static void discard(struct staged *s) {
    if (!s) return;
    if (s->parent >= 0) { if (*s->temp) unlinkat(s->parent,s->temp,0); close(s->parent); }
    free(s->name); free(s);
}
JNIEXPORT jlong JNICALL JNI_FN(stage)(JNIEnv *e, jclass c, jstring root, jstring pkg, jstring path, jbyteArray data) {
    (void)c; char *p = NULL, *name = NULL;
    int base = target(e,root,pkg,path,&p), fd = -1, old = -1;
    struct staged *s = calloc(1,sizeof(*s));
    if (!s) { if (base>=0) close(base); free(p); fail(e); return 0; }
    s->parent = base >= 0 ? parent_at(base,p,&name) : -1;
    if (base>=0) close(base);
    if (name) s->name = strdup(name);
    free(p);
    jsize size = data ? (*e)->GetArrayLength(e,data) : -1;
    if (s->parent < 0 || !s->name || size < 0 || size > MAX_FILE) goto bad;
    old = beneath(s->parent,s->name,O_RDONLY | O_NONBLOCK,0);
    s->existed = old >= 0;
    if (old < 0 && errno != ENOENT) goto bad;
    struct stat meta;
    if (old >= 0) {
        if (fstat(old,&meta) || !S_ISREG(meta.st_mode) || meta.st_nlink != 1 || meta.st_size > MAX_FILE) goto bad;
        s->original = meta;
    } else if (fstat(s->parent,&meta)) goto bad;
    unsigned char random[16];
    if (syscall(__NR_getrandom,random,sizeof(random),0) != sizeof(random)) goto bad;
    strcpy(s->temp,".lecturn-");
    for (int i=0;i<16;i++) snprintf(s->temp+9+i*2,3,"%02x",random[i]);
    fd = beneath(s->parent,s->temp,O_WRONLY | O_CREAT | O_EXCL,0600);
    if (fd < 0) goto bad;
    if (fchown(fd,meta.st_uid,meta.st_gid) || fchmod(fd,old >= 0 ? meta.st_mode & 0777 : 0600)) goto bad;
    // Atomic replacement must retain the app's SELinux context. No unlabeled fallback.
    char label[4096]; ssize_t label_size = fgetxattr(old >= 0 ? old : s->parent,"security.selinux",label,sizeof(label));
    if (label_size <= 0 || fsetxattr(fd,"security.selinux",label,(size_t)label_size,0)) goto bad;
    jbyte *b = (*e)->GetByteArrayElements(e,data,NULL);
    if (!b) goto bad;
    size_t used = 0;
    while (used < (size_t)size) {
        ssize_t n = write(fd,b+used,(size_t)size-used);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        used += (size_t)n;
    }
    (*e)->ReleaseByteArrayElements(e,data,b,JNI_ABORT);
    if (used != (size_t)size || fsync(fd)) goto bad;
    close(fd); if (old>=0) close(old);
    return (jlong)(intptr_t)s;
bad:
    if (fd>=0) close(fd);
    if (old>=0) close(old);
    discard(s); fail(e); return 0;
}
JNIEXPORT void JNICALL JNI_FN(commit)(JNIEnv *e, jclass c, jlong handle) {
    (void)c; struct staged *s = (struct staged *)(intptr_t)handle;
    if (!s) { fail(e); return; }
    struct stat now;
    int found = fstatat(s->parent,s->name,&now,AT_SYMLINK_NOFOLLOW) == 0;
    if (s->existed ? (!found || !S_ISREG(now.st_mode) || now.st_nlink != 1 || now.st_ino != s->original.st_ino || now.st_dev != s->original.st_dev || now.st_mtim.tv_sec != s->original.st_mtim.tv_sec || now.st_mtim.tv_nsec != s->original.st_mtim.tv_nsec) : (found || errno != ENOENT)) { fail(e); return; }
    // rename does not follow the destination, even if an app swaps it after fstatat.
    // Concurrent live app writes remain unsupported; this is not a database transaction.
    if (renameat(s->parent,s->temp,s->parent,s->name)) { fail(e); return; }
    s->temp[0] = '\0';
    if (fsync(s->parent)) fail(e); // Failure may be after commit; caller must reconcile.
}
JNIEXPORT void JNICALL JNI_FN(discard)(JNIEnv *e, jclass c, jlong handle) { (void)e; (void)c; discard((struct staged *)(intptr_t)handle); }
JNIEXPORT void JNICALL JNI_FN(delete)(JNIEnv *e, jclass c, jstring root, jstring pkg, jstring path) {
    (void)c; char *p = NULL, *name = NULL;
    int base = target(e,root,pkg,path,&p);
    int parent = base >= 0 ? parent_at(base,p,&name) : -1;
    if (base>=0) close(base);
    struct stat st;
    if (parent < 0 || fstatat(parent,name,&st,AT_SYMLINK_NOFOLLOW) || !S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_size > MAX_FILE || unlinkat(parent,name,0) || fsync(parent)) fail(e);
    if (parent>=0) close(parent);
    free(p);
}
