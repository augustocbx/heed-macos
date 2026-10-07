/* Fixed arity avoids Darwin arm64 variadic calling conventions at the Bun FFI boundary. */
#include <sys/types.h>
#include <fcntl.h>
#include <dirent.h>
#include <string.h>
#include <errno.h>

int qa_openat(int directory, const char *name, int flags, int mode) {
    return openat(directory, name, flags | O_CLOEXEC, (mode_t)mode);
}

/* One entry per call: caller owns the small inventory bound and directory lifetime. */
int qa_directory_name(DIR *directory, char *name, int capacity) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (!entry) return errno ? -1 : 0;
    size_t length = strlen(entry->d_name);
    if (length + 1 > (size_t)capacity) return -1;
    memcpy(name, entry->d_name, length + 1);
    return (int)length;
}
