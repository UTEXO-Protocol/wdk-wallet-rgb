// SPDX-License-Identifier: Apache-2.0
// Appended to wallet/core.rs only in the isolated SDK host test build.
pub(crate) fn run_verified_colored_outputs_fixture() {
    use bdk_wallet::bitcoin::{TxIn, TxOut, absolute::LockTime, transaction::Version};

    fn payment(wallet: &mut Wallet, source: u8, keychains: &[KeychainKind]) -> BdkTransaction {
        BdkTransaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: BdkOutPoint {
                    txid: format!("{source:02x}").repeat(32).parse().unwrap(),
                    vout: 0,
                },
                ..Default::default()
            }],
            output: keychains
                .iter()
                .map(|&keychain| TxOut {
                    value: BdkAmount::from_sat(10_000),
                    script_pubkey: wallet
                        .bdk_wallet_mut()
                        .reveal_next_address(keychain)
                        .address
                        .script_pubkey(),
                })
                .collect(),
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let data = WalletData {
        data_dir: dir.path().to_str().unwrap().into(),
        bitcoin_network: BitcoinNetwork::Regtest,
        database_type: DatabaseType::Sqlite,
        max_allocations_per_utxo: 1,
        supported_schemas: vec![AssetSchema::Nia],
    };
    let keys = crate::keys::generate_keys(data.bitcoin_network, WitnessVersion::Taproot);
    let keys = SinglesigKeys::from_keys(&keys, None);
    let mut wallet = Wallet::new(data.clone(), keys.clone()).unwrap();
    wallet.require_verified_colored_outputs();

    let observed = payment(&mut wallet, 1, &[KeychainKind::External; 4]);
    let setup = payment(
        &mut wallet,
        2,
        &[KeychainKind::External, KeychainKind::Internal],
    );
    let observed_id = observed.compute_txid();
    let setup_id = setup.compute_txid();
    let script_only = observed.output[1].script_pubkey.to_hex_string();
    let observed_outpoint = |vout| BdkOutPoint {
        txid: observed_id,
        vout,
    };
    let setup_outpoint = BdkOutPoint {
        txid: setup_id,
        vout: 0,
    };
    let pending_scripts = HashMap::from([(script_only.clone(), true)]);
    let txn = wallet.database().begin_transaction().unwrap();
    txn.set_pending_witness_script(DbPendingWitnessScriptActMod {
        script: ActiveValue::Set(script_only.clone()),
        ..Default::default()
    })
    .unwrap();
    // A validated witness receive and exact RGB change have a row even
    // before the on-chain output is known. A script match alone is no proof.
    for (vout, pending_witness) in [(2, true), (3, false)] {
        txn.set_txo(DbTxoActMod {
            txid: ActiveValue::Set(observed_id.to_string()),
            vout: ActiveValue::Set(vout),
            btc_amount: ActiveValue::Set("0".into()),
            spent: ActiveValue::Set(false),
            exists: ActiveValue::Set(false),
            pending_witness: ActiveValue::Set(pending_witness),
            ..Default::default()
        })
        .unwrap();
    }
    txn.set_wallet_transaction(DbWalletTransactionActMod {
        txid: ActiveValue::Set(setup_id.to_string()),
        r#type: ActiveValue::Set(WalletTransactionType::CreateUtxos),
        ..Default::default()
    })
    .unwrap();
    wallet
        .bdk_wallet_mut()
        .apply_unconfirmed_txs([(observed, 1), (setup, 2)]);
    wallet
        .update_db_colored_txos_from_bdk(&txn, false, &pending_scripts)
        .unwrap();
    wallet.persist_and_commit(txn).unwrap();
    drop(wallet);

    // Reopen, rescan the same BDK graph and verify that the observed outputs
    // cannot enter the allocation pool or a native vanilla BTC plan.
    let mut wallet = Wallet::new(data, keys).unwrap();
    wallet.require_verified_colored_outputs();
    let txn = wallet.database().begin_transaction().unwrap();
    wallet
        .update_db_colored_txos_from_bdk(&txn, true, &pending_scripts)
        .unwrap();
    assert_eq!(
        txn.iter_pending_witness_scripts().unwrap()[0].script,
        script_only
    );
    for vout in [0, 1] {
        assert!(
            txn.get_txo(&observed_outpoint(vout).into())
                .unwrap()
                .is_none()
        );
    }
    for (outpoint, pending) in [
        (observed_outpoint(2), true),
        (observed_outpoint(3), false),
        (setup_outpoint, false),
    ] {
        let txo = txn.get_txo(&outpoint.into()).unwrap().unwrap();
        assert!(txo.exists);
        assert_eq!(txo.btc_amount, "10000");
        assert_eq!(txo.pending_witness, pending);
    }
    let select = |exclusions: &[Outpoint]| {
        wallet
            .get_utxo(&txn, exclusions, None, false, None)
            .unwrap()
            .outpoint()
    };
    let first = select(&[]);
    let second = select(std::slice::from_ref(&first));
    let allocatable = HashSet::from([first, second]);
    assert_eq!(
        allocatable,
        HashSet::from([observed_outpoint(3).into(), setup_outpoint.into()])
    );
    assert!(
        wallet
            .get_utxo(
                &txn,
                &allocatable.into_iter().collect::<Vec<_>>(),
                None,
                false,
                None
            )
            .is_err()
    );
    let excluded = wallet.get_unspendable_bdk_outpoints(&txn).unwrap();
    assert!(excluded.contains(&observed_outpoint(0)));
    assert!(excluded.contains(&observed_outpoint(1)));
    assert!(!excluded.contains(&BdkOutPoint {
        txid: setup_id,
        vout: 1
    }));
    wallet.persist_and_commit(txn).unwrap();
    let balance = wallet.get_btc_balance(None, true).unwrap();
    assert_eq!(balance.vanilla.spendable, 10_000);
    assert_eq!(balance.colored.spendable, 30_000);
}
