#ifndef LECTURN_SECUREFS_PATHS_H
#define LECTURN_SECUREFS_PATHS_H
#include <string.h>
#include <strings.h>

// Native validation repeats the Java boundary before any filesystem operation.
static inline int relative(const char *p, int empty) {
    if (!p || strlen(p) > 1024 || *p == '/' || strchr(p, '\\')) return 0;
    if (!*p) return empty;
    const char *s = p;
    for (;;) {
        const char *end = strchr(s, '/');
        size_t n = end ? (size_t)(end-s) : strlen(s);
        if (!n || n > 200 || (n == 1 && s[0] == '.') || (n == 2 && s[0] == '.' && s[1] == '.')) return 0;
        if (n >= 9 && !strncasecmp(s, ".lecturn-", 9)) return 0;
        if (!end) break;
        s = end+1;
    }
    return 1;
}
static inline int public_root(const char *root) {
    return !strcmp(root,"storage") || !strcmp(root,"downloads") || !strcmp(root,"documents");
}
static inline int target_path(const char *root, const char *path) {
    if (!relative(path,1)) return 0;
    // Android/data, media and obb must use package roots, never this broader alias.
    if (!strcmp(root,"storage") && !strncasecmp(path,"Android",7)
        && (!path[7] || path[7]=='/')) return 0;
    return 1;
}
#endif
