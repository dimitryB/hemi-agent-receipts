# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's private vulnerability reporting on this repository (the **Security** tab, then **Report a vulnerability**). Do not open a public issue for anything that could put funds, receipts or keys at risk.

A useful report says which component is affected, how to reproduce the problem, and what an attacker gains. You can expect an acknowledgement within a few days.

## Scope

- `ReceiptRegistry` on Hemi mainnet, [`0x95127A8aCa9B5c235C56A2dfd315a567Ef545A40`](https://explorer.hemi.xyz/address/0x95127A8aCa9B5c235C56A2dfd315a567Ef545A40), and on Hemi testnet, [`0xef9Bb805581c0E947DEA54052Ad360485c3F73Fe`](https://testnet.explorer.hemi.xyz/address/0xef9Bb805581c0E947DEA54052Ad360485c3F73Fe). The contract is not upgradeable; its owner is a Safe that can pause it, void a batch or rotate the service signer ([docs/RUNBOOK.md](docs/RUNBOOK.md)).
- The SDK (`sdk/`), the CLI (`cli/`), the attestation service (`service/`) and the viewer (`viewer/`), above all anything that lets `verify` call a receipt valid when it is not.

Third-party services the project reads from, such as Hemi's RPC, the Bitcoin Esplora APIs and the x402 facilitator, are out of scope; report problems in them to their maintainers.

## Known dependency advisories

Advisories that `npm audit` reports and that cannot be fixed yet are listed, with why they do not reach the published packages, under **Known limits** in the [README](README.md#known-limits).

## Status of review

The contracts had an internal review, recorded in [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md). It is not an independent third-party audit.
