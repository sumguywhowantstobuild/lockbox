# Third-party notices

## EFF Large Wordlist for Passphrases

- File: `crates/lockbox-core/wordlists/eff_large_wordlist.txt` (7,776 words, stored unchanged, byte for byte)
- Author: Electronic Frontier Foundation (EFF), 2016
- Source: https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt
- Downloaded: 2026-10-13
- SHA-256: `addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e`
- Licence: Creative Commons Attribution 3.0 United States (CC BY 3.0 US), https://creativecommons.org/licenses/by/3.0/us/

Used by the passphrase generator (`crates/lockbox-core/src/generator.rs`). The list is used as published; Lockbox does not modify it. This credit is required by the licence.

## BIP39 English word list (the recovery key's words)

- File: `crates/lockbox-core/src/wordlist/english.txt` (2,048 words, stored unchanged, byte for byte, LF endings)
- Source: `src/mnemonic/wordlist/english.txt` of Trezor's `python-mnemonic`, https://github.com/trezor/python-mnemonic
  (last changed in that repository 2021-07-27). The same list is published as `bip-0039/english.txt` in
  https://github.com/bitcoin/bips; the two files were compared when this one was added and are byte-identical.
- Downloaded: 2026-11-06
- SHA-256: `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda` (a test pins it)
- Licence: MIT, Copyright (c) 2013-2016 Pavol Rusnak. The notice that must stay with the list:

> The MIT License (MIT)
>
> Copyright (c) 2013-2016 Pavol Rusnak
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
> persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
> Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
> WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Used by the recovery key (`crates/lockbox-core/src/recovery.rs`): its 24 words are written from this list. The list is
used as published; Lockbox does not modify it.

## Libraries the desktop app uses directly

Exact versions are pinned in `Cargo.lock` and `ui/package-lock.json`. The full licence texts of these libraries and of
what they depend on ship with the installer (Plan 5); nothing is distributed before then.

| Library | Version | Licence | Used for |
|---|---|---|---|
| `tauri`, `tauri-build` | 2.12.5, 2.7.4 | Apache-2.0 or MIT | The app toolkit |
| `tauri-plugin-single-instance` | 2.5.4 | Apache-2.0 or MIT | One copy of the app |
| `rfd` | 0.17.2 | MIT | File dialogs |
| `clipboard-win` | 5.4.3 | BSL-1.0 | Opening and reading the clipboard |
| `error-code` (through `clipboard-win`) | 3.4.0 | BSL-1.0 | Windows error codes |
| `webview2-com` | 0.39.1 | MIT | WebView2's own settings: turning off external file drop, its menus and browser keys; printing and saving as PDF |
| `windows-core`, `windows-sys` | 0.62.2, 0.61.2 | MIT or Apache-2.0 | Windows calls |
| `getrandom` | 0.4.3 | MIT or Apache-2.0 | A clipboard copy's random tag |
| `serde`, `serde_json` | 1.0.229, 1.0.151 | MIT or Apache-2.0 | Requests, answers and state files |
| `zeroize` | 1.9.1 | Apache-2.0 or MIT | Wiping typed passwords |
| `react`, `react-dom` | 19.3.1 | MIT | The page |
| `@tauri-apps/api` | 2.12.4 | Apache-2.0 or MIT | The page's bridge to Rust |
| `@base-ui/react` | 1.9.0 | MIT | Behaviour and accessibility of dialogs, menus, lists and forms |
| `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` | 5.3.0 | OFL-1.1 | The Geist and Geist Mono typefaces, bundled so no font is fetched |

The UI's build and test tools (Vite, TypeScript, ESLint, Vitest and their helpers, listed in `ui/package.json`) do not
ship with the app.
