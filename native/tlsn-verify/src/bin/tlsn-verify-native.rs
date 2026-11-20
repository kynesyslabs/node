//! Native twin of the wasm verifier, used only as a cross-engine oracle over
//! the golden vectors (`build.sh parity`). It is never part of the node.
//! Usage: tlsn-verify-native <presentation.bin> [pinned-root.der]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 || args.len() > 3 {
        eprintln!("usage: tlsn-verify-native <presentation.bin> [pinned-root.der]");
        std::process::exit(2);
    }
    let pres = std::fs::read(&args[1]).expect("read presentation");
    let root = args.get(2).map(|p| std::fs::read(p).expect("read root"));
    let v = demos_tlsn_verify::verify_presentation(&pres, root.as_deref());
    println!("{}", serde_json::to_string(&v).unwrap());
}
