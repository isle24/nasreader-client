# Desktop client notices

nasReader client source is licensed under AGPL-3.0; see LICENSE. User books, credentials, subscription packs and NAS data are not part of this distribution.

| Component | License | Source |
| --- | --- | --- |
| vue, vue-router | MIT | https://github.com/vuejs/core |
| vite, @vitejs/plugin-vue, vue-tsc, vitest, openapi-typescript, @playwright/test, fake-indexeddb | MIT | respective upstream repositories |
| idb | ISC | https://github.com/jakearchibald/idb |
| pdfjs-dist (including bundled decoder assets and fallback fonts) | Apache-2.0 and notices distributed with pdfjs-dist | https://github.com/mozilla/pdf.js |
| foliate-js | MIT | https://github.com/johnfactotum/foliate-js |
| tauri, tauri-build, @tauri-apps/api, @tauri-apps/cli | MIT or Apache-2.0 | https://github.com/tauri-apps/tauri |
| keyring and platform credential backends | MIT or Apache-2.0 | https://github.com/open-source-cooperative/keyring-rs |
| url | MIT or Apache-2.0 | https://github.com/servo/rust-url |

Dependency versions and transitive libraries are pinned in front-end/package-lock.json, client/package-lock.json and client/src-tauri/Cargo.lock. Fonts and PDF decoder resources are emitted from the locked PDF.js package, including their upstream license/notice resources. Application artwork is generated from the project's own client/assets/icon.svg.

Windows uses Credential Manager; macOS uses Keychain; Linux uses the desktop Secret Service over the user session bus. No server implementation or third-party book source rules are included in this client repository.
