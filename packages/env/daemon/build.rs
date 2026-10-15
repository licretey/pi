//! 将 npm 包版本写入 `PI_ENV_VERSION`，以便 hello 命令报告此守护进程随附的版本。

fn main() {
    println!("cargo:rerun-if-changed=../package.json");
    let package = std::fs::read_to_string("../package.json").expect("read ../package.json");
    let version = package
        .split("\"version\"")
        .nth(1)
        .and_then(|rest| rest.split('"').nth(1))
        .expect("version in ../package.json");
    println!("cargo:rustc-env=PI_ENV_VERSION={version}");
}
