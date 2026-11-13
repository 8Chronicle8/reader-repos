# Signing key

The APKs in `patched/` are signed with a key generated on 2026-08-14 (RSA 4096,
SHA384withRSA, valid until about 2056, alias `anikku`). Anikku checks every
APK against its fingerprint, published in `patched/repo.json`:

```
304491c40ccada54da1a825d77397861e96ae88577e681cb2f90463bb4a4144d
```

## Where it lives

Outside this repository, on purpose: a private key does not belong in version
control, and `*.jks` / `*.keystore` are gitignored. The build reads its path
from `ANIKKU_KEYSTORE` and its password from `ANIKKU_KEYSTORE_PASS`; neither
is written anywhere by the scripts.

## Back it up

If the key is lost, every installed `-P` extension has to be uninstalled and
reinstalled by hand: Android refuses an update whose signing certificate
changed, so Anikku would show updates that can never install. Keep a copy in a
password manager or an encrypted backup (the file is 4.4 KB).

## Rotating deliberately

1. Generate the new key, re-sign every APK, and put the new fingerprint in
   `patched/repo.json` (`package_repo.py` does both).
2. Uninstall the `-P` extensions in Anikku and reinstall them from the repo.

Uninstalling does not delete library entries or history. The `-P` sources have
their own source ids (see the README), and those ids do not depend on the key,
so the library survives a key change.

## Checking an APK

```sh
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs patched/apk/<name>.apk
```

The `Signer #1 certificate SHA-256 digest` it prints is the value Anikku
compares with `repo.json`.
