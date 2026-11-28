use rgb_lib::no_wallet::{BundleFilter, inspect_consignment};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("public proof file").clone();
    let txid = args.get(2).expect("Bitcoin witness transaction ID").clone();
    let result = inspect_consignment(path, BundleFilter::Witness(txid)).expect("valid public proof");
    println!("{}", serde_json::to_string(&result).unwrap());
}
