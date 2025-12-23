// Copyright 2024 RGB OS Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
'use strict'
/** @typedef {import('rgb-sdk').Transaction} RgbTransactionReceipt */
/** @typedef {import('rgb-sdk').RgbTransfer} RgbTransferReceipt */
/** @typedef {import('@tetherto/wdk-wallet').FeeRates} FeeRates */
/** @typedef {import('@tetherto/wdk-wallet').KeyPair} KeyPair */
/** @typedef {import('@tetherto/wdk-wallet').TransactionResult} TransactionResult */
/** @typedef {import('@tetherto/wdk-wallet').TransferOptions} TransferOptions */
/** @typedef {import('@tetherto/wdk-wallet').TransferResult} TransferResult */

/** @typedef {import('./src/wallet-account-read-only-rgb.js').RgbTransaction} RgbTransaction */
/** @typedef {import('./src/wallet-account-read-only-rgb.js').RgbWalletConfig} RgbWalletConfig */

export { default } from './src/wallet-manager-rgb.js'

export { default as WalletAccountReadOnlyRgb } from './src/wallet-account-read-only-rgb.js'

export { default as WalletAccountRgb } from './src/wallet-account-rgb.js'
