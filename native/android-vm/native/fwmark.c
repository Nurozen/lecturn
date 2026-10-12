/* Android fwmark wire protocol from AOSP system/netd/include/FwmarkCommand.h
 * (Apache-2.0). Uses the caller's default network, never VPN protection.
 * Parent-qualified ABI: ON_CONNECT=1, 16-byte command + 36-byte connect info.
 */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/time.h>
#include <stdint.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
#include <dlfcn.h>
#include <pthread.h>

static int (*next_connect)(int, const struct sockaddr *, socklen_t);
static ssize_t (*next_sendto)(int, const void *, size_t, int, const struct sockaddr *, socklen_t);
static ssize_t (*next_sendmsg)(int, const struct msghdr *, int);
static pthread_once_t once = PTHREAD_ONCE_INIT;

static void load(void) {
    *(void **)(&next_connect) = dlsym(RTLD_NEXT, "connect");
    *(void **)(&next_sendto) = dlsym(RTLD_NEXT, "sendto");
    *(void **)(&next_sendmsg) = dlsym(RTLD_NEXT, "sendmsg");
}
static int loaded(void) {
    pthread_once(&once, load);
    if (next_connect && next_sendto && next_sendmsg) return 1;
    errno = ENOSYS;
    return 0;
}
static int mark(int fd, const struct sockaddr *dst, socklen_t length) {
    if (!dst || length < sizeof(sa_family_t)) return 0;
    if (dst->sa_family != AF_INET && dst->sa_family != AF_INET6) return 0;
    size_t addrsize = dst->sa_family == AF_INET ? 16 : 28;
    if (length < addrsize) { errno = EINVAL; return -1; }
    int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (s < 0) return -1;
    struct timeval timeout = {2, 0};
    int result = -EIO;
    if (setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) ||
        setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout))) goto done;
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    strcpy(address.sun_path, "/dev/socket/fwmarkd");
    if (next_connect(s, (struct sockaddr *)&address, sizeof(address)) < 0) { result = -errno; goto done; }
    unsigned char request[52] = {0};
    uint32_t command = 1;
    memcpy(request, &command, sizeof(command));
    memcpy(request + 24, dst, addrsize);
    struct iovec iov = {request, sizeof(request)};
    union { struct cmsghdr alignment; char bytes[CMSG_SPACE(sizeof(fd))]; } control = {0};
    struct msghdr message = {0};
    message.msg_iov = &iov;
    message.msg_iovlen = 1;
    message.msg_control = control.bytes;
    message.msg_controllen = sizeof(control.bytes);
    struct cmsghdr *cmsg = CMSG_FIRSTHDR(&message);
    cmsg->cmsg_level = SOL_SOCKET;
    cmsg->cmsg_type = SCM_RIGHTS;
    cmsg->cmsg_len = CMSG_LEN(sizeof(fd));
    memcpy(CMSG_DATA(cmsg), &fd, sizeof(fd));
    if (next_sendmsg(s, &message, MSG_NOSIGNAL) != sizeof(request)) goto done;
    if (recv(s, &result, sizeof(result), MSG_WAITALL) != sizeof(result)) result = -EIO;
done:
    close(s);
    if (result) { errno = result < 0 ? -result : EIO; return -1; }
    return 0;
}
int connect(int fd, const struct sockaddr *address, socklen_t length) {
    if (!loaded() || mark(fd, address, length)) return -1;
    return next_connect(fd, address, length);
}
ssize_t sendto(int fd, const void *buffer, size_t size, int flags, const struct sockaddr *address, socklen_t length) {
    if (!loaded() || mark(fd, address, length)) return -1;
    return next_sendto(fd, buffer, size, flags, address, length);
}
ssize_t sendmsg(int fd, const struct msghdr *message, int flags) {
    if (!loaded()) return -1;
    if (!message) { errno = EINVAL; return -1; }
    if (mark(fd, message->msg_name, message->msg_namelen)) return -1;
    return next_sendmsg(fd, message, flags);
}
