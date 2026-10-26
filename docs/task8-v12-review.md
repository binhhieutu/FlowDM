# Task 8 review — 0.12.0

Baseline 5cb8b99. One independent code/security review scanned45changed paths, syntaxchecked39JSfiles and reproduced important findings. All code findings were fixed; no second review replaced regression evidence. FAT/exFAT and full YouTube-through-proxy qualification remain explicit incomplete checklist items.

| Finding | Fix and evidence |
|---|---|
| High: FTP identity lacked authenticated principal | Domain-separated SHA256 binds URL+username, never password or plaintextuser. Two-account/samepath/SIZE/MDTM/differentbytes naturalRED→GREEN; engine/refreshedcredential binding rejects mismatch |
| High: crash after publish could bypass antivirus | Persist pending scan before publish, interrupted scans become failed, explicit rescan verifies file SHA before/after and reconsiders queue completion. Publication-boundary RED→GREEN plus actual packaged processkill during scan→relaunch→explicitrescan |
| High: proxy-bound task validation could probe directly after restart | Central route authorization for refresh/header rebind before networking. Postfix real HTTP+SOCKS zero-origin regression passes; this dedicated test was written after guard implementation, no RED claim |
| Medium: proxy sent URL fragment upstream | Clone URL and clear hash before any absolute request; realHTTP/SOCKS naturalRED→GREEN, query retained, callerURL unchanged |
| Medium: schema 8/legacy FTP protocol mismatch | Legacy1–7 use HTTP-only validation;8 enforces FTP/FTPS iff mediaTypeftp. Negative schema 7FTP/schema 8mismatch RED→GREEN |
| Medium: clipboard path could expose token | Banner displays origin only; query/path/fragment token regression RED→GREEN, actual URL stays only current RAM suggestion/input |
| Low regraded as privacy lifetime fix | Drop FTP credentials after publication/cancellation; retain only paused/failed retryable sessions; terminal lifecycle assertions pass |
| Checklist update | Mark8a/8b/8d/8f/8g; keep8c/8e parent unchecked with testedsubsets and blockers |

Final packaged validation discovered a real Windows rename EPERM under strict concurrent journal polling. Added Windows-only EPERM/EACCES/EBUSY retries of the same already-synced temporary file, max6attempts at10/20/40/80/160ms. No copy/in-place fallback or permission changes; permanent refusal preserves old journal and cleans temp. NaturalRED→GREEN16filesystem cases; strict processkill/relaunch passes on rebuilt artifact. Candidate1is not final certification. Candidate2passed but was rebuilt again after uniform batch/native duplicate checks; candidate3 is the final hash in evidence.

## Decisions and costs

- Settings/category policy apply to future task destinations; explicit directory wins, existing tasks never move. Executable MIME/extension conflicts conservatively go Programs. Cost: category is organizational, not a security verdict.
- Scanner is opt-in, absolute executable+argv, shellfalse, bounded runtime/output, after publication. Failure/interruption is separate from completed download; no FlowDM deletion/quarantine. Explicit rescan checks original SHA and failed/pending scan blocks automatic completion actions. Cost: vendors follow their configured flags; choose scan-only behavior. MicrosoftDefender benign customscan with DisableRemediation passed separately.
- Proxy upstream credentials are RAM-only. An authenticated loopback gateway supplies HTTP CONNECT/SOCKS5 to Node/media tools; only its ephemeral capability can appear in childargv. Fixed exact app-ownedrelay bypasses preserve actualremoteproxy routing. Cost: same-account observers can see a temporary local capability, and active work must pause before changing proxy.
- Proxy-created jobs retain nonsecret requiresProxy. Restart never falls back directly; reconfigure or explicitly allow direct on a stopped task. No NTLM/Kerberos, TLS-to-proxy or FTP-proxy adapter. Cost: additional manual rebind after restart. Remote HTTPS/FTPS certificate checks stay enabled.
- FTP/explicitFTPS use passive EPSV/PASV and one connection; SIZE+MDTM plus URL/principal binding guard resume, including recheck after transfer. No URL credentials; account/password only RAM. Cost: this is metadata-based identity, not a remote cryptographic content hash; no implicitFTPS/activeFTP/GUI directory browser.
- Clipboard watcher is opt-in, no history or automatic download. Duplicate source+exactselection+query guard applies to desktop, batch and browser admission; fragments do not distinguish resources. Batch reports per-item refusal; browser stream is retained on rejected handoff. Cost: use explicit manual override or disable duplicate warnings when intentionally downloading another copy.
- FAT/exFAT remain unsupported; all observed volumes are NTFS and no safe native fallback was proven. Guard FAT32>4294967295B, fail closed, preserve hardlink publication. Cost: use a supported destination filesystem;8e stays unchecked.
- Crash tests kill only owned app/child processes and inject storage failures; they do not establish survival of all power failures. No host disk, proxy, antivirus policy or daily-browser changes. Local commits only, no publication/memory edits.

Real YouTube proxy qualification failed due upstream HTTP 401 after partialtransfer. It is NOT a PASS; no full file/SHA/decode exists and no alternateclient/access bypass was attempted. HTTP/HLS/DASH/browser proxy fixtures and actual authenticated routing passed.8c remains partially checked rather than claiming every media provider works.

References: [basic-ftp/MIT](https://github.com/patrickjuchli/basic-ftp), [upstream security advisory](https://github.com/patrickjuchli/basic-ftp/security/advisories/GHSA-chqc-8p9q-pq6q), [SOCKS5](https://www.rfc-editor.org/rfc/rfc1928), [SOCKS username/password](https://www.rfc-editor.org/rfc/rfc1929), [Windows filesystem comparison](https://learn.microsoft.com/en-us/windows/win32/fileio/filesystem-functionality-comparison), [Defender CLI](https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus).
