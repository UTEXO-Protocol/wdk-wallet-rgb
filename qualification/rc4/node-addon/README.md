# Node addon: funded upgrade and recovery qualification

The complete RC4 pack at source `1323731494ec83b87a54d415ea942deaee04e52d` was installed with dependency scripts disabled. Its SHA-256 is `b6054baafa939a0cdbda1f127d666b6ef9a46661c14873204822875350bb3b6d`. The runner verifies every archive file against the installed consumer and matches both native binaries to the admitted platform receipt before any new financial operation.

## Fixture and baseline

This extends the committed RC4 [funded-upgrade fixture](../funded-upgrade-fixture/) and its [URL-parser rebuild runners](../funded-upgrade-fixture/release-rerun/). Follow their source/Compose setup first; do not substitute hosted endpoints. Keep the original qualification root `Q`: its owned `fixture/` services and retained wallets; `baseline/` Bare runtime and proof inspector build inputs; `upstream-upgrade-audit/` inspector and issuer executables; and `release-preparation/funded-rerun/` previous wallets and receipts. The owned service ports are Bitcoin 48443, Electrum 48001, RGB proxy 48090 and Anvil 48545. No hosted service or shared baseline stack is used.

Place these runners in a new private `Q/node-addon/funded/` directory. `local_fixture.py setup` creates a separate issuer and asset using the existing local deployment. It never resets an existing issuer. The fresh issuer starts with ten mint rights; after the two baseline mints, eight settled, unspent and unreserved rights were independently checked against SQLite and Bitcoin before the final phase.

The exact old executable RC4 package has SHA-256 `c7b42d8bc1bde6ea5f02a66aa1f7927115ac9a3678eaf702a7480c71aa447dbe`. Its Node executable is `b05c4a61e54de051008290aeae0316a651dc3cad27139a8f11ba216f699f41cb`; its Bare addon is `a6d2a4eb956466a7e71dedb6386fc6198e55e9031911c1eb6de74c6b875d7eed`.

```sh
python3 local_fixture.py setup
# Record the deployment backing before either baseline mint:
python3 - <<'PYCODE'
import json
from pathlib import Path
from local_fixture import fixture, SOURCE
p = Path.cwd()
d = json.loads((SOURCE / 'deployment.json').read_text())
bridge = d['bridge']['deployedTo']
token = d['token']['deployedTo']
def value(contract, signature, *args):
    return str(int(fixture.cast('call', contract, signature, *args,
        '--rpc-url', 'http://127.0.0.1:8545').split()[0], 0))
assert not (p / 'backing-before.json').exists()
(p / 'backing-before.json').write_text(json.dumps({
    'bridgeBackingBefore': value(token, 'balanceOf(address)(uint256)', bridge),
    'circulatingSupplyBefore': value(bridge, 'circulatingSupply()(uint64)')
}, indent=2) + '\n')
PYCODE
node qualify.mjs snapshot /absolute/old-consumer /absolute/old-native-executable
node qualify.mjs prepare-baseline /absolute/old-consumer /absolute/old-native-executable
node qualify.mjs run /absolute/new-consumer /absolute/new-pack/prebuilds/darwin-arm64/utexo-rgb-native.node /absolute/platforms.json /absolute/new-package.tgz
python3 audit.py
```

The corrected `snapshot` phase covers all ten existing funded wallets. The recorded run first captured six, then used the included read-only `snapshot-extra.mjs` to add the four URL-parser qualification wallets before final-pack execution. That helper requires an existing six-wallet snapshot without the extra fields and is not needed when using the corrected `snapshot` phase. Its source digest is retained in the receipt. Two fresh old-package wallets then acquire BFA mints, burn proofs, NIA/CFA assets and pending blinded invoices. The final pack opens those exact directories in place and checks keys, balances, all transfer fields, original proofs and invoice reuse without another allocation or approval. The final phase also creates two fresh recipients.

## Financial verification

The final pack performs two new mints, four new NIA/CFA issuances, twelve transfers (BTC, BFA and both original and newly issued NIA/CFA assets) and ten V1 burns across Arbitrum, Ethereum, Polygon, Plasma and Tron. Each mutation uses its original persisted ID. Each runtime deliberately loses one successful `burnEnd` reply, then recovers that burn without another invocation. Duplicate requests are rejected and proofs and transfers are recovered after complete process restart.

`audit.py` independently checks confirmed Bitcoin transactions, fees and RGB commitments; decodes proofs using the original upstream inspector; verifies NIA/CFA issuance supply and transferred amounts; reconstructs destination commitments with Foundry; checks Tron encoding separately; and reconciles EVM lock payments and backing. It includes the two baseline mints and burns as well as final-pack activity.

## Recorded harness correction

The first final phase stopped after a confirmed Node BFA transfer because an added audit step called the public `getConsignment` method for an ordinary transfer. That method intentionally exposes recorded burn proofs only. This was a fixture error, not a rejected transfer.

The corrected reproducible runner reads the exact saved normal-transfer consignment from the disposable fixture for independent inspection. `resume-after-proof-check.mjs` records the actual continuation: it requires the original run ID, submitted operation journal, identical transaction ID, at least six confirmations and exact expected balances before continuing. It does not replay the transfer, mint or funding. This continuation is specific to that recorded checkpoint and must not be used as a generic restart command. The public receipts retain the correction and its reconciliation evidence.

Do not rerun a financial phase with existing state markers or delete markers to bypass them. Reconcile any interruption against its journal and chain transaction first. Generated seeds, issuer keys, wallet directories and raw proof files stay private; only sanitized receipts and runner sources belong in Git.

The funded scope is Darwin ARM64 Node 26 and unchanged Bare 1.37.1. Other supported Node targets have separate native and packed-consumer acceptance. This fixture does not claim EVM `fundsOut` redemption, hosted gateway/TEE acceptance, public-network payouts or new mobile acceptance.

## Repeat the independent audit

With the original private qualification root and its saved proofs still present, run:

```sh
python3 /absolute/Q/node-addon/funded/audit.py
```

The command reads wallet-independent evidence, Bitcoin/EVM RPC results and saved proof files. It does not open wallets, sign, broadcast, mint, burn or replay operations. It rewrites only the local `financial-reconciliation.json` audit output. The committed `financial-release.json` adds package/provenance metadata to that raw result; `funded-release.json` points to the sanitized receipt by its filename and SHA-256.
