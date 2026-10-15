//! WHATWG UTF-8 解码行为与 Node 对完整输入调用 `new TextDecoder().decode(bytes)` 一致，即使输入分块到达
//!（Durable 的 `env/decode.ts`）：无效序列按最大子部规则替换为 U+FFFD，并且只会移除
//! 输入开头的字节顺序标记。

use encoding_rs::{Decoder, UTF_8};

/// 逐块解码数据流，并移除开头的字节顺序标记。
pub struct StreamDecoder {
    decoder: Decoder,
}

impl StreamDecoder {
    pub fn new() -> StreamDecoder {
        // 只移除 UTF-8 BOM；普通的 `new_decoder()` 还会检测 UTF-16 BOM 并切换编码。
        StreamDecoder {
            decoder: UTF_8.new_decoder_with_bom_removal(),
        }
    }

    /// 解码 `bytes` 中的文本，并暂存不完整的字符；`last` 表示是否已到数据流末尾。
    pub fn decode(&mut self, bytes: &[u8], last: bool) -> String {
        decode_into(&mut self.decoder, bytes, last)
    }
}

/// 用于解码非输入开头字节范围的解码器：完全不处理 BOM。
pub fn range_decoder() -> Decoder {
    UTF_8.new_decoder_without_bom_handling()
}

pub fn decode_into(decoder: &mut Decoder, bytes: &[u8], last: bool) -> String {
    let capacity = decoder
        .max_utf8_buffer_length(bytes.len())
        .unwrap_or(bytes.len() * 3 + 16);
    let mut text = String::with_capacity(capacity);
    let (_result, read, _replaced) = decoder.decode_to_string(bytes, &mut text, last);
    debug_assert_eq!(read, bytes.len());
    text
}

/// 判断解码完整输入时是否会将开头三个字节作为 BOM 移除。
pub fn starts_with_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xef, 0xbb, 0xbf])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_feff_that_does_not_start_the_stream() {
        let mut decoder = StreamDecoder::new();
        let bytes = [0xe2, 0x82, 0xef, 0xbb, 0xbf, 0x61];
        let text: String = bytes
            .iter()
            .map(|byte| decoder.decode(&[*byte], false))
            .collect::<String>()
            + &decoder.decode(&[], true);
        assert_eq!(text, "\u{fffd}\u{feff}a");
    }

    #[test]
    fn drops_only_a_leading_mark_and_never_sniffs_utf16() {
        let mut decoder = StreamDecoder::new();
        assert_eq!(
            decoder.decode(&[0xef, 0xbb], false) + &decoder.decode(&[0xbf, 0x61], true),
            "a"
        );
        let mut decoder = StreamDecoder::new();
        assert_eq!(
            decoder.decode(&[0xff, 0xfe, 0x41, 0x00], true),
            "\u{fffd}\u{fffd}A\u{0}"
        );
    }

    #[test]
    fn replaces_an_incomplete_sequence_once() {
        let mut decoder = StreamDecoder::new();
        assert_eq!(decoder.decode(&[0xe2, 0x82, 0x41], true), "\u{fffd}A");
        let mut decoder = StreamDecoder::new();
        assert_eq!(decoder.decode(&[0xe2, 0x82], true), "\u{fffd}");
    }
}
