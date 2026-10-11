#include <assert.h>
#include <stdio.h>
#include "../native/securefs_paths.h"

int main(void) {
    const char *allowed[] = {"", "DCIM/Camera/photo.jpg", "Pictures/image.png", "Movies/video.mp4",
        "Music/song.flac", "Recordings/audio.wav", "Download/file", "Documents/notes",
        "owner-file.txt", "Android-backup/file", "nested/Android/file"};
    const char *denied[] = {"Android", "Android/data", "android/media/com.example.app/file",
        "ANDROID/obb/com.example.app/file", "Android/data/com.cloudgatherer.lecturn.symba/files/token",
        "Android/media/com.android.keychain/file", "../10/DCIM/file", "/data/media/10/file",
        "DCIM/../../1/file", "DCIM//file", "DCIM/./file", "DCIM/../file", "DCIM\\file",
        "DCIM/.LECTURN-stage", ".lecturn-stage"};
    for (size_t i=0; i<sizeof(allowed)/sizeof(*allowed); i++) assert(target_path("storage",allowed[i]));
    for (size_t i=0; i<sizeof(denied)/sizeof(*denied); i++) assert(!target_path("storage",denied[i]));
    assert(public_root("storage") && public_root("downloads") && public_root("documents"));
    assert(!public_root("obb") && !public_root("ce") && !public_root("/data/media/0"));
    assert(target_path("media","Android/file"));
    assert(!target_path("ce","files/.lecturn-stage"));
    assert(!target_path("storage",NULL));
    puts("securefs_paths_test: native owner storage boundaries passed");
    return 0;
}
