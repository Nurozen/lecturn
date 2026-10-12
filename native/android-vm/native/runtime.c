#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <limits.h>
#include <sched.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define ROOT "/data/local/symba-runtime"
#define HOST ROOT "/host"
#define PACKAGE "com.cloudgatherer.lecturn.symba"
static void fail(const char *message) {
    /* Only fixed diagnostic strings; never echo command output or credentials. */
    dprintf(1, "{\"schemaVersion\":1,\"status\":\"error\",\"message\":\"%s\"}\n", message);
    _exit(1);
}
static void deadline(int sig) {
    (void)sig;
    const char msg[] = "{\"schemaVersion\":1,\"status\":\"error\",\"message\":\"launcher deadline\"}\n";
    (void)write(1, msg, sizeof(msg)-1);
    _exit(1);
}
static void check(int result, const char *message) { if (result < 0) fail(message); }
static void trusted(const char *path, bool directory) {
    struct stat s;
    if (lstat(path, &s)) fail("untrusted installation path");
    /* Android owns /data as system:system 0771. App UIDs cannot rename its
       root-owned /data/local child; do not change the platform directory. */
    if (!strcmp(path, "/data") && directory && S_ISDIR(s.st_mode)
            && s.st_uid == 1000 && s.st_gid == 1000 && (s.st_mode & 07777) == 0771) return;
    if (s.st_uid || (s.st_mode & 0022) ||
        (directory ? !S_ISDIR(s.st_mode) : !S_ISREG(s.st_mode))) fail("untrusted installation path");
}
static void make_dir(const char *path, mode_t mode) {
    if (mkdir(path, mode) && errno != EEXIST) fail("mkdir failed");
    trusted(path, true);
    check(chmod(path, mode), "directory mode failed");
}
static void capture(char *const args[], char *out, size_t size) {
    int pipefd[2]; check(pipe2(pipefd, O_CLOEXEC), "pipe failed");
    pid_t child = fork(); check(child, "fork failed");
    if (!child) {
        dup2(pipefd[1], 1);
        int nullfd = open("/dev/null", O_WRONLY);
        if (nullfd < 0 || dup2(nullfd, 2) < 0) _exit(126);
        close(pipefd[0]); close(pipefd[1]); close(nullfd);
        alarm(3);
        char *env[] = {"PATH=/system/bin", "LANG=C", NULL};
        execve(args[0], args, env); _exit(127);
    }
    close(pipefd[1]); size_t used = 0;
    while (used < size-1) {
        ssize_t n = read(pipefd[0], out+used, size-1-used);
        if (n <= 0) break;
        used += (size_t)n;
    }
    close(pipefd[0]); int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status) || used == size-1)
        fail("Android package or activity query failed");
    out[used] = 0;
}
static unsigned package_uid(void) {
    char output[2048];
    char *args[] = {"/system/bin/cmd", "package", "list", "packages", "-U", "--user", "0", PACKAGE, NULL};
    capture(args, output, sizeof(output));
    const char prefix[] = "package:" PACKAGE " uid:";
    unsigned uid = 0; char extra;
    if (strncmp(output, prefix, sizeof(prefix)-1) ||
        sscanf(output+sizeof(prefix)-1, "%u %c", &uid, &extra) != 1 || uid < 10000 || uid >= 100000)
        fail("package must resolve to one user-zero application UID");
    return uid;
}
static bool active_uid(unsigned uid) {
    char number[24], output[256]; snprintf(number, sizeof(number), "%u", uid);
    char *args[] = {"/system/bin/cmd", "activity", "get-uid-state", number, NULL};
    capture(args, output, sizeof(output));
    char *end; long state = strtol(output, &end, 10);
    /* Accept only Android's numeric foreground states, including FGS (4). */
    return end != output && (*end == ' ' || *end == '\n' || !*end) && state >= 0 && state <= 4;
}
static void verify_private(void) {
    struct stat current, init;
    check(stat("/proc/self/ns/mnt", &current), "proc namespace unavailable");
    check(stat("/proc/1/ns/mnt", &init), "init namespace unavailable");
    if (current.st_ino == init.st_ino) fail("host mount namespace rejected");
    FILE *f = fopen("/proc/self/mountinfo", "re");
    if (!f) fail("mountinfo unavailable");
    char *line = NULL; size_t size = 0;
    while (getline(&line, &size, f) >= 0) {
        char *sep = strstr(line, " - "); if (!sep) fail("invalid mountinfo");
        *sep = 0;
        if (strstr(line, " shared:") || strstr(line, " master:")) fail("mount propagation not private");
    }
    free(line); fclose(f);
}
static void private_mounts(void) {
    struct stat before, after;
    check(stat("/proc/self/ns/mnt", &before), "proc namespace unavailable");
    check(unshare(CLONE_NEWNS), "mount namespace unavailable");
    check(mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL), "recursive private mounts failed");
    check(stat("/proc/self/ns/mnt", &after), "namespace verification failed");
    if (before.st_ino == after.st_ino) fail("namespace did not change");
    verify_private();
}
static void node(const char *name, mode_t mode, unsigned major_n, unsigned minor_n, unsigned uid) {
    char path[256]; snprintf(path, sizeof(path), HOST "/dev/%s", name);
    check(mknod(path, S_IFCHR | mode, makedev(major_n, minor_n)), "device creation failed");
    check(chown(path, uid, uid), "device ownership failed");
    check(chmod(path, mode), "device mode failed");
}
static void prepare_host(unsigned uid) {
    const char *dirs[] = {"/data", "/data/local", ROOT, HOST, ROOT "/bin", ROOT "/state",
        HOST "/dev", HOST "/proc", HOST "/run", HOST "/run/symba-state", HOST "/opt",
        HOST "/opt/vm", HOST "/usr", HOST "/usr/local", HOST "/usr/local/libexec", NULL};
    for (int i=0; dirs[i]; i++) trusted(dirs[i], true);
    struct stat private_dir;
    check(stat(ROOT, &private_dir), "runtime root unavailable");
    if ((private_dir.st_mode & 0777) != 0700) fail("runtime root must be private");
    check(stat(ROOT "/state", &private_dir), "state unavailable");
    if ((private_dir.st_mode & 0777) != 0700) fail("state must be private");
    trusted(ROOT "/bin/runtime-control", false);
    trusted(HOST "/usr/local/libexec/runtime-helper", false);
    trusted(HOST "/usr/local/libexec/runtime_controller.py", false);
    struct stat kvm; check(stat("/dev/kvm", &kvm), "KVM unavailable");
    if (!S_ISCHR(kvm.st_mode)) fail("invalid KVM device");
    private_mounts();
    check(mount("tmpfs", HOST "/dev", "tmpfs", MS_NOSUID | MS_NOEXEC, "mode=0755,size=1m"), "private dev failed");
    node("null", 0666, 1, 3, 0); node("zero", 0666, 1, 5, 0);
    node("random", 0666, 1, 8, 0); node("urandom", 0666, 1, 9, 0);
    node("tty", 0666, 5, 0, 0);
    node("kvm", 0600, major(kvm.st_rdev), minor(kvm.st_rdev), uid);
    make_dir(HOST "/dev/pts", 0755);
    check(mount("devpts", HOST "/dev/pts", "devpts", MS_NOSUID | MS_NOEXEC, "newinstance,ptmxmode=0666,mode=0620"), "private devpts failed");
    check(symlink("pts/ptmx", HOST "/dev/ptmx"), "ptmx failed");
    check(symlink("/proc/self/fd", HOST "/dev/fd"), "fd link failed");
    make_dir(HOST "/dev/socket", 0755);
    int fd = open(HOST "/dev/socket/fwmarkd", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
    check(fd, "socket placeholder failed"); close(fd);
    check(mount("/dev/socket/fwmarkd", HOST "/dev/socket/fwmarkd", NULL, MS_BIND, NULL), "fwmark socket bind failed");
    check(mount("proc", HOST "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL), "private proc failed");
    check(mount(ROOT "/state", HOST "/run/symba-state", NULL, MS_BIND, NULL), "controller state bind failed");
    check(chdir(HOST), "host root unavailable"); check(chroot("."), "host chroot failed"); check(chdir("/"), "chdir failed");
}
static void trusted_program(const char *path) {
    /* Ubuntu's interpreter/firmware may use root-owned symlinks. Resolve only
     * after entering the root-owned host tree, then validate the canonical chain. */
    char resolved[PATH_MAX];
    if (!realpath(path, resolved)) fail("required host dependency unavailable");
    for (char *cursor = resolved + 1; *cursor; cursor++) {
        if (*cursor == '/') {
            *cursor = 0; trusted(resolved, true); *cursor = '/';
        }
    }
    trusted(resolved, false);
}
static unsigned number(const char *s, unsigned min, unsigned max) {
    char *end; unsigned long n = strtoul(s, &end, 10);
    if (!*s || *end || n < min || n > max) fail("invalid numeric argument");
    return (unsigned)n;
}
static void drop(unsigned uid) {
    gid_t groups[] = {3003};
    check(setgroups(1, groups), "inet group failed");
    for (int cap=0; cap<=CAP_LAST_CAP; cap++) check(prctl(PR_CAPBSET_DROP, cap, 0, 0, 0), "capability bounding drop failed");
    check(setresgid(uid, uid, uid), "gid drop failed"); check(setresuid(uid, uid, uid), "uid drop failed");
    struct __user_cap_header_struct h = {_LINUX_CAPABILITY_VERSION_3, 0};
    struct __user_cap_data_struct caps[2] = {{0}, {0}};
    check(syscall(SYS_capset, &h, caps), "capability drop failed");
    check(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "no_new_privs failed");
    check(syscall(SYS_capget, &h, caps), "capability verification failed");
    for (int i=0; i<2; i++) if (caps[i].effective || caps[i].permitted || caps[i].inheritable) fail("capabilities remain");
    for (int cap=0; cap<=CAP_LAST_CAP; cap++) if (prctl(PR_CAPBSET_READ, cap, 0, 0, 0) != 0) fail("bounding capabilities remain");
}
int main(int argc, char **argv) {
    umask(0077);
    if (getuid() || geteuid()) fail("root launcher required");
    if (argc == 5 && !strcmp(argv[1], "--qemu")) {
        unsigned uid = number(argv[2], 10000, 99999);
        (void)number(argv[3], 512, 8192); (void)number(argv[4], 1, 8);
        /* Parent records this PID and starttime durably before opening the gate. */
        char gate; if (read(0, &gate, 1) != 1 || gate != 'G') fail("launch gate closed");
        int nullfd = open("/dev/null", O_RDONLY); check(nullfd, "null unavailable");
        check(dup2(nullfd, 0), "stdin detach failed"); close(nullfd);
        verify_private();
        drop(uid);
        char *env[] = {"PATH=/usr/bin:/bin", "LANG=C", "LD_PRELOAD=/usr/local/lib/libsymba-fwmark.so", NULL};
        char *args[] = {"/usr/bin/qemu-system-aarch64", "-name", "lecturn-symba", "-machine", "virt,accel=kvm,gic-version=3",
            "-cpu", "host", "-smp", argv[4], "-m", argv[3], "-bios", "/usr/share/qemu-efi-aarch64/QEMU_EFI.fd",
            "-drive", "if=none,file=/opt/vm/guest.qcow2,id=root,format=qcow2", "-device", "virtio-blk-pci,drive=root",
            "-drive", "if=none,file=/opt/vm/seed.iso,id=seed,format=raw,readonly=on", "-device", "virtio-blk-pci,drive=seed",
            "-netdev", "user,id=net0,ipv6=off,hostfwd=tcp:127.0.0.1:18722-:22,hostfwd=tcp:127.0.0.1:3773-:3773",
            "-device", "virtio-net-pci,netdev=net0,romfile=", "-display", "none", "-serial", "file:/opt/vm/console.log",
            "-qmp", "unix:/opt/vm/run/qmp.sock,server=on,wait=off", "-monitor", "none", NULL};
        execve(args[0], args, env); fail("QEMU exec failed");
    }
    if (argc != 2 || (strcmp(argv[1], "start") && strcmp(argv[1], "stop") && strcmp(argv[1], "status"))) fail("expected start stop or status");
    signal(SIGALRM, deadline); alarm(28);
    bool stopping = !strcmp(argv[1], "stop");
    unsigned uid = stopping ? 0 : package_uid();
    bool active = stopping ? false : active_uid(uid);
    prepare_host(uid);
    trusted_program("/usr/bin/python3");
    trusted_program("/usr/bin/qemu-system-aarch64");
    trusted_program("/usr/bin/ssh");
    trusted_program("/usr/local/lib/libsymba-fwmark.so");
    trusted_program("/usr/share/qemu-efi-aarch64/QEMU_EFI.fd");
    char uidstr[24]; snprintf(uidstr, sizeof(uidstr), "%u", uid);
    char *args[] = {"/usr/bin/python3", "-I", "/usr/local/libexec/runtime_controller.py", argv[1], uidstr, active ? "active" : "inactive", NULL};
    char *env[] = {"PATH=/usr/bin:/bin", "LANG=C", "HOME=/root", NULL};
    execve(args[0], args, env); fail("controller exec failed");
}
