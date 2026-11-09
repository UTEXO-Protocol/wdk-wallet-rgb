// SPDX-License-Identifier: Apache-2.0
use crate::engine::{Credentials, Result, input, validated_url};
use rgb_lib::BitcoinNetwork;
use rgb_lib::no_wallet::SignetCheckpoint;
use rgb_lib::wallet::IndexerConfig;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::OnceLock;
use zeroize::Zeroize;

const SIGNET_ELECTRUM: &str = "ssl://electrum.iriswallet.com:50033";
const DEV_SERVICES_JSON: &str = include_str!("../../src/onchain-dev-services.json");

pub(crate) struct SignetServices {
    pub(crate) proxy: &'static str,
    pub(crate) arbitrum_rpc: &'static str,
}

const STAGING_SERVICES: SignetServices = SignetServices {
    proxy: "rpcs://staging.rgb-proxy.utexo.com/json-rpc",
    arbitrum_rpc: "https://arb1.arbitrum.io/rpc",
};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DevServices {
    enabled: bool,
    indexer_url: &'static str,
    proxy_endpoint: &'static str,
    arbitrum_rpc: &'static str,
}

impl DevServices {
    fn require_enabled(&self) -> Result<&Self> {
        if !self.enabled {
            return Err(input("Dev Signet hosted access is disabled."));
        }
        Ok(self)
    }
}

fn dev_services() -> Result<&'static DevServices> {
    static CONFIG: OnceLock<Option<DevServices>> = OnceLock::new();
    CONFIG.get_or_init(|| serde_json::from_str(DEV_SERVICES_JSON).ok())
        .as_ref()
        .ok_or_else(|| input("Dev Signet service policy is invalid."))
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Profile {
    Staging,
    Dev,
}

impl Profile {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Staging => "staging",
            Self::Dev => "dev",
        }
    }

    pub(crate) fn services(self) -> Result<SignetServices> {
        match self {
            Self::Staging => Ok(STAGING_SERVICES),
            Self::Dev => {
                let services = dev_services()?.require_enabled()?;
                Ok(SignetServices {
                    proxy: services.proxy_endpoint,
                    arbitrum_rpc: services.arbitrum_rpc,
                })
            }
        }
    }
}

pub(crate) fn signet_checkpoint(profile: Option<Profile>) -> SignetCheckpoint {
    match profile {
        Some(Profile::Dev) => SignetCheckpoint::Dev,
        _ => SignetCheckpoint::Public,
    }
}

pub(crate) fn version(source: &str, overlay: &str) -> Value {
    json!({
        "protocol": 2,
        "source": source,
        "overlayTree": overlay,
        "integrationTree": "8a012db8c770db8c10be554dcdd34c95b16f81a8",
        "runtime": crate::RUNTIME,
        "indexer": "electrum-and-dev-esplora",
        "networkChecks": 4,
        "unsignedRecovery": 1,
        "journalWrites": 1,
    })
}

pub(crate) fn indexer(
    indexer_url: String,
    auth: Option<Credentials>,
    network: BitcoinNetwork,
    profile: Option<Profile>,
) -> Result<IndexerConfig> {
    if let Some(mut auth) = auth {
        auth.username.zeroize();
        auth.password.zeroize();
        return Err(input(
            "Bitcoin Core credentials are not supported by this wallet.",
        ));
    }
    if network == BitcoinNetwork::Signet {
        if matches!(profile, Some(Profile::Dev)) {
            let approved = dev_services()?.require_enabled()?.indexer_url;
            if indexer_url.strip_suffix('/').unwrap_or(&indexer_url) != approved {
                return Err(input("Dev Signet requires the approved HTTPS Esplora endpoint."));
            }
            return Ok(IndexerConfig::DevSignetEsplora { url: approved.into() });
        }
        let approved = SIGNET_ELECTRUM;
        if indexer_url.strip_suffix('/').unwrap_or(&indexer_url) != approved {
            return Err(input("Signet requires the approved TLS Electrum endpoint for its profile."));
        }
        return Ok(IndexerConfig::Electrum { url: approved.into() });
    }
    if network != BitcoinNetwork::Regtest || profile.is_some() {
        return Err(input("Unsupported Bitcoin network."));
    }
    let url = validated_url(&indexer_url, &["ssl", "tcp"], true)?;
    let (Some(host), Some(port)) = (url.host_str(), url.port()) else {
        return Err(input("The Electrum endpoint requires an explicit host and port."));
    };
    if !matches!(url.path(), "" | "/") {
        return Err(input(
            "The Electrum endpoint requires an explicit port and no path or query.",
        ));
    }
    Ok(IndexerConfig::Electrum {
        url: format!("{}://{host}:{port}", url.scheme()),
    })
}

pub(crate) fn clear_indexer_credentials(_: &mut IndexerConfig) {}

pub(crate) fn after_wallet_new() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_only_electrum_with_plain_tcp_restricted_to_regtest() {
        let regtest = BitcoinNetwork::Regtest;
        let signet = BitcoinNetwork::Signet;
        assert!(indexer("tcp://127.0.0.1:48001".into(), None, regtest, None).is_ok());
        assert_eq!(indexer(format!("{SIGNET_ELECTRUM}/"), None, signet, None).unwrap().url(), SIGNET_ELECTRUM);
        assert!(indexer(SIGNET_ELECTRUM.into(), None, regtest, None).is_err());
        for url in [
            "tcp://example.test:50001",
            "tcp://electrum.iriswallet.com:50033",
            "ssl://electrum.iriswallet.com:50033//",
            "ssl://electrum.iriswallet.com:50033?",
            "ssl://example.test",
            "ssl://example.test:50002",
            "ssl://example.test:50002/rpc",
            "ssl://example.test:50002?timeout=0",
            "ssl://name:pw@example.test:50002",
            "https://example.test:443",
            "http://127.0.0.1:8332",
        ] {
            assert!(indexer(url.into(), None, signet, None).is_err(), "accepted {url}");
        }
        let credentials = Credentials {
            username: "user".into(),
            password: "pass".into(),
        };
        assert!(indexer("tcp://127.0.0.1:48001".into(), Some(credentials), regtest, None).is_err());
    }

    #[test]
    fn dev_admits_only_pinned_services_and_its_own_esplora_checkpoint() {
        const DEV_ESPLORA: &str = "https://dev.esplora-01.mint.utexo.com";
        let services = dev_services().unwrap();
        assert_eq!(services.indexer_url, DEV_ESPLORA);
        assert_eq!(services.proxy_endpoint, "rpcs://dev.rgb-proxy.utexo.com/json-rpc");
        assert_eq!(services.arbitrum_rpc, "https://arb1.arbitrum.io/rpc");
        let active = Profile::Dev.services().unwrap();
        assert_eq!(active.proxy, services.proxy_endpoint);
        assert_eq!(active.arbitrum_rpc, services.arbitrum_rpc);
        assert_eq!(
            signet_checkpoint(Some(Profile::Dev)).block_one(),
            "0000001b808e4ece11c0cd922eaf9eee8d7dfba7e23e90b4f9614248daaf72cb"
        );
        assert_ne!(
            signet_checkpoint(Some(Profile::Dev)).block_one(),
            signet_checkpoint(Some(Profile::Staging)).block_one()
        );
        for url in [DEV_ESPLORA.into(), format!("{DEV_ESPLORA}/")] {
            assert!(matches!(
                indexer(url, None, BitcoinNetwork::Signet, Some(Profile::Dev)).unwrap(),
                IndexerConfig::DevSignetEsplora { url } if url == DEV_ESPLORA
            ));
        }
        for url in [
            "http://dev.esplora-01.mint.utexo.com",
            "https://dev.esplora-01.mint.utexo.com/redirect",
            "https://dev.esplora-01.mint.utexo.com?",
            "https://other.example",
        ] {
            assert!(indexer(url.into(), None, BitcoinNetwork::Signet, Some(Profile::Dev)).is_err());
        }
        assert!(indexer(DEV_ESPLORA.into(), None, BitcoinNetwork::Signet, Some(Profile::Staging)).is_err());
        assert!(indexer(SIGNET_ELECTRUM.into(), None, BitcoinNetwork::Signet, Some(Profile::Dev)).is_err());
        assert!(indexer("ssl://127.0.0.1:48002".into(), None, BitcoinNetwork::Signet, Some(Profile::Dev)).is_err());
        assert!(indexer("tcp://127.0.0.1:48001".into(), None, BitcoinNetwork::Regtest, Some(Profile::Dev)).is_err());
    }

    #[test]
    fn a_disabled_dev_service_policy_cannot_return_active_endpoints() {
        let config: DevServices = serde_json::from_str(r#"{
            "enabled":false,
            "indexerUrl":"https://dev-esplora.example",
            "proxyEndpoint":"rpcs://dev-proxy.example/json-rpc",
            "arbitrumRpc":"https://arb.example/rpc"
        }"#).unwrap();
        assert!(config.require_enabled().is_err());
    }
}
