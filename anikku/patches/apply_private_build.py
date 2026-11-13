#!/usr/bin/env python3
"""Teach an anime-extensions checkout to build "-P" side-by-side variants.

usage: apply_private_build.py <anime-extensions-checkout>

After this, `./gradlew -PprivateSuffix=p -PprivateBuild=N :src:<lang>:<name>:assembleRelease`
builds an extension that installs next to the official one:

  applicationId   eu.kanade.tachiyomi.animeextension.<lang>.<name>.p
                  Android refuses two APKs with one package name, and with a
                  different signing key that is a hard failure, not an update.
  class meta-data written absolute. The manifest otherwise names the class
                  relative to the applicationId (".ExtensionGenerated"), which
                  after the suffix points at a class that does not exist.
  keep rule       names the class in the source package, for the same reason;
                  R8 would otherwise strip the real class from the release APK.
  names           "<name>-P" for the extension and every source. The source id
                  is md5(name/lang/versionId), so the id changes on purpose: an
                  unchanged id would make Anikku shadow one source with the other.
  versionCode     + privateBuild, so a rebuilt fix is offered as an update.

Without -PprivateSuffix the build is unchanged. Each edit asserts the exact
upstream text it replaces and stops if that text has moved; it never guesses.
Running it twice is a no-op.
"""
import os
import sys

MARK = "privateSuffix"


def edit(path, pairs):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if MARK in text:
        print(f"  = {os.path.relpath(path)} already patched")
        return
    for old, new in pairs:
        count = text.count(old)
        if count != 1:
            sys.exit(f"{path}: expected exactly one occurrence of\n{old}\nfound {count}; "
                     "upstream changed -- update this script")
        text = text.replace(old, new)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"  + {os.path.relpath(path)}")


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    root = os.path.abspath(sys.argv[1])
    kotlin = os.path.join(root, "gradle/build-logic/src/main/kotlin")

    edit(os.path.join(kotlin, "ExtensionPlugin.kt"), [
        (
            '        val applicationIdSuffix = "${project.parent?.name}.${project.name}"\n',
            '        val applicationIdSuffix = "${project.parent?.name}.${project.name}"\n'
            '        // privateSuffix: build a side-by-side variant (see the anikku/patches README).\n'
            '        val privateSuffix = (project.findProperty("privateSuffix") as String?)?.takeIf { it.isNotEmpty() }\n'
            '        val privateBuild = (project.findProperty("privateBuild") as String?)?.toInt() ?: 0\n'
            '        val packageSuffix = if (privateSuffix != null) "$applicationIdSuffix.$privateSuffix" else applicationIdSuffix\n'
            '        val nameSuffix = if (privateSuffix != null) "-${privateSuffix.uppercase()}" else ""\n',
        ),
        (
            '                this.applicationIdSuffix = applicationIdSuffix\n',
            '                this.applicationIdSuffix = packageSuffix\n',
        ),
        (
            '            themeKeiyoushi.baseVersionCode.zip(keiyoushi.versionCode) { base, ext -> base + ext }\n'
            '        }.orElse(keiyoushi.versionCode)\n',
            '            themeKeiyoushi.baseVersionCode.zip(keiyoushi.versionCode) { base, ext -> base + ext + privateBuild }\n'
            '        }.orElse(keiyoushi.versionCode.map { it + privateBuild })\n',
        ),
        (
            '        }.orElse("ExtensionGenerated")\n',
            '        }.orElse("ExtensionGenerated").map { cls ->\n'
            '            if (privateSuffix != null && !cls.contains(\'.\')) {\n'
            '                "eu.kanade.tachiyomi.animeextension.$applicationIdSuffix.$cls"\n'
            '            } else {\n'
            '                cls\n'
            '            }\n'
            '        }\n',
        ),
        (
            '                keiyoushi.name.map { name ->\n'
            '                    check(name.all { it.code < 0x180 }) { "Extension name should be romanized" }\n'
            '                    name\n'
            '                },\n',
            '                keiyoushi.name.map { name ->\n'
            '                    check(name.all { it.code < 0x180 }) { "Extension name should be romanized" }\n'
            '                    name + nameSuffix\n'
            '                },\n',
        ),
        (
            '            archivesName.set(versionNameProvider.map { "aniyomi-$applicationIdSuffix-v$it" })\n',
            '            archivesName.set(versionNameProvider.map { "aniyomi-$packageSuffix-v$it" })\n',
        ),
        (
            '            val extName = keiyoushi.name.get()\n'
            '            val resolvedSources = specs.map { spec ->\n'
            '                val name = spec.name.orElse(extName).get()\n',
            '            val extName = keiyoushi.name.get() + nameSuffix\n'
            '            val resolvedSources = specs.map { spec ->\n'
            '                val name = spec.name.map { it + nameSuffix }.orElse(extName).get()\n'
            '                check(privateSuffix == null || !spec.id.isPresent) {\n'
            '                    "A private build renames sources to get distinct ids, but this source pins id=${spec.id.get()}"\n'
            '                }\n',
        ),
        (
            '            val packageName = "eu.kanade.tachiyomi.animeextension.$applicationIdSuffix"\n',
            '            val packageName = "eu.kanade.tachiyomi.animeextension.$packageSuffix"\n',
        ),
    ])

    tasks = os.path.join(kotlin, "io/github/keiyoushi/gradle/tasks")
    edit(os.path.join(tasks, "GenerateManifestTask.kt"), [
        (
            '<meta-data android:name="tachiyomi.animeextension.class" android:value=".$cls" />',
            '<meta-data android:name="tachiyomi.animeextension.class" android:value="${if (cls.contains(\'.\')) cls else ".$cls"}" />',
        ),
        (
            '        val cls = className.get()\n',
            '        // privateSuffix builds pass an absolute class name; see ExtensionPlugin.\n'
            '        val cls = className.get()\n',
        ),
    ])
    edit(os.path.join(tasks, "GenerateKeepRulesTask.kt"), [
        (
            '            writeText("-keep class ${applicationId.get()}.${className.get()} { <init>(); }\\n")\n',
            '            // privateSuffix builds pass an absolute class name; see ExtensionPlugin.\n'
            '            val cls = className.get().let { if (it.contains(\'.\')) it else "${applicationId.get()}.$it" }\n'
            '            writeText("-keep class $cls { <init>(); }\\n")\n',
        ),
    ])


if __name__ == "__main__":
    main()
