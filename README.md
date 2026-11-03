# @utexo/wdk-wallet-rgb

Private review candidate for the on-chain RGB wallet SDK. It uses a watch-only RGB BFA engine and an application-owned signer. Node and Android Bare use the same pinned Electrum-only native graph.

The candidate supports isolated Regtest for Bitcoin and RGB, plus Bitcoin-only and staging RGB profiles for public Signet. The staging profile pins its services and requires separate hosted asset and bridge qualification. The [candidate guide](CANDIDATE.md) covers configuration, build, API, authorization and recovery. The [qualification register](QUALIFICATION.md) tracks release gates and the Iris integration contract.
