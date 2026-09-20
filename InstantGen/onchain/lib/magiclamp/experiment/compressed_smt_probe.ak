// SINH TỰ ĐỘNG bởi scratchpad/gen_compressed.py — phép đo thử nghiệm, KHÔNG validator nào import.

// SMT nén nhị phân: lá một-mình thu gọn lên tiền tố duy nhất ngắn nhất; E = 32 byte 0;

// L(k)=blake2b_256(0x00‖k); H(l,r)=blake2b_256(0x01‖l‖r).



use aiken/cbor
use aiken/collection/list

use aiken/crypto.{blake2b_256}

use aiken/primitive/bytearray

use magiclamp/experiment/pa2_smt.{key_bit}



pub type Terminal {
  Empty
  Leaf(ByteArray)
}

const e32: ByteArray =
  #"0000000000000000000000000000000000000000000000000000000000000000"

fn h_leaf(k: ByteArray) -> ByteArray {
  blake2b_256(bytearray.concat(#"00", k))
}

fn h_node(l: ByteArray, r: ByteArray) -> ByteArray {
  blake2b_256(bytearray.concat(#"01", bytearray.concat(l, r)))
}

fn fold(key: ByteArray, node: ByteArray, rev: List<ByteArray>, level: Int) -> ByteArray {
  when rev is {
    [] -> node
    [s, ..rest] ->
      if key_bit(key, level) == 0 {
        fold(key, h_node(node, s), rest, level - 1)
      } else {
        fold(key, h_node(s, node), rest, level - 1)
      }
  }
}

fn first_diff(a: ByteArray, b: ByteArray, i: Int) -> Int {
  if key_bit(a, i) == key_bit(b, i) {
    first_diff(a, b, i + 1)
  } else {
    i
  }
}

fn wrap(key: ByteArray, node: ByteArray, lvl: Int, d: Int) -> ByteArray {
  if lvl < d {
    node
  } else if key_bit(key, lvl) == 0 {
    wrap(key, h_node(node, e32), lvl - 1, d)
  } else {
    wrap(key, h_node(e32, node), lvl - 1, d)
  }
}

fn split(key: ByteArray, lk2: ByteArray, k2: ByteArray, d: Int) -> ByteArray {
  let c = first_diff(key, k2, d)
  let lk = h_leaf(key)
  let pair =
    if key_bit(key, c) == 0 {
      h_node(lk, lk2)
    } else {
      h_node(lk2, lk)
    }
  wrap(key, pair, c - 1, d)
}

/// Bản A (giống khuôn pa2_smt): sibling trên→dưới, list.length + list.reverse, gập HAI lượt.
pub fn insert_ok_a(old_root: ByteArray, new_root: ByteArray, key: ByteArray, t: Terminal, sibs: List<ByteArray>) -> Bool {
  let d = list.length(sibs)
  let rev = list.reverse(sibs)
  when t is {
    Empty -> and {
        fold(key, e32, rev, d - 1) == old_root,
        fold(key, h_leaf(key), rev, d - 1) == new_root,
      }
    Leaf(k2) -> {
      let lk2 = h_leaf(k2)
      and {
        k2 != key,
        fold(key, lk2, rev, d - 1) == old_root,
        fold(key, split(key, lk2, k2, d), rev, d - 1) == new_root,
      }
    }
  }
}

/// Chỉ kiểm vắng mặt (không tính root mới) — bản A.
pub fn absent_ok_a(root: ByteArray, key: ByteArray, t: Terminal, sibs: List<ByteArray>) -> Bool {
  let d = list.length(sibs)
  let rev = list.reverse(sibs)
  when t is {
    Empty -> fold(key, e32, rev, d - 1) == root
    Leaf(k2) -> and { k2 != key, fold(key, h_leaf(k2), rev, d - 1) == root }
  }
}

fn fold2(key: ByteArray, o: ByteArray, n: ByteArray, rev: List<ByteArray>, level: Int, old_root: ByteArray, new_root: ByteArray) -> Bool {
  when rev is {
    [] -> and { level == -1, o == old_root, n == new_root }
    [s, ..rest] ->
      if key_bit(key, level) == 0 {
        fold2(key, h_node(o, s), h_node(n, s), rest, level - 1, old_root, new_root)
      } else {
        fold2(key, h_node(s, o), h_node(s, n), rest, level - 1, old_root, new_root)
      }
  }
}

/// Bản B: sibling dưới→trên, d do redeemer khai (kiểm level == -1 ở đáy), gập MỘT lượt.
pub fn insert_ok_b(old_root: ByteArray, new_root: ByteArray, key: ByteArray, t: Terminal, rev: List<ByteArray>, d: Int) -> Bool {
  when t is {
    Empty -> fold2(key, e32, h_leaf(key), rev, d - 1, old_root, new_root)
    Leaf(k2) -> {
      let lk2 = h_leaf(k2)
      and { k2 != key, fold2(key, lk2, split(key, lk2, k2, d), rev, d - 1, old_root, new_root) }
    }
  }
}


const d10_leaf_key: ByteArray = #"2abadaf96d28ac531830424a4d111f361cb096b4ddf021b816bc6e4b54cb53bc"
const d10_leaf_old: ByteArray = #"d05d52b994b001353ffc7e22df776ae884ad8045e6058237ef8e171c5a11d77b"
const d10_leaf_new: ByteArray = #"1d28ae40c7a188ad47eccc8f2246cfd7b7bb59b54aee06bb630c5f214150ac9f"
const d10_leaf_bogus: ByteArray = #"ba8405fdbfbaa4e996a7d63247a9777a70a6b771aa6d3676ab5bc70603a39eea"

const d10_leaf_sibs: List<ByteArray> = [
  #"82818ba6e8c63b926b78a3d52d18f66fa1ba0b6391c12be8d1138b98a56ced47",
  #"cbddca5fe24099bdf25787c3a9be981bacf2c3617b9f567ea7ad255025c43718",
  #"f9f4ebfc1f0e856794480156291cccb23bc9329acef765eefef5069e447d93e5",
  #"624016f2defd51d6a705a457c9ee9d02668314e1fbdc05135288f72f3491aec4",
  #"4917d61d8ea40ed3948c5289327dcb3f341b872d193f87340f825d449d83570c",
  #"69cc3b380826c14fbfdf77ef2aadf51186d32c40bfa94e79ed7e361dacda2f6d",
  #"39b2612f1649a23e2f34b03dd0718a5032f70d8278038c56de7104fc4e17fd05",
  #"19844762591bc13bf7935a8f7c8b47bed1ddb0af049c41a66af147df90b9d535",
  #"1d85877a7f20541af8ed1df2fa7d0748b23d16ae79a77fe47ab567499d756ca2",
  #"e16bd49369c7a488896c427c053a6c0a5369a5becc93bf32a9190c91cfd18178",
]
const d10_leaf_rev: List<ByteArray> = [
  #"e16bd49369c7a488896c427c053a6c0a5369a5becc93bf32a9190c91cfd18178",
  #"1d85877a7f20541af8ed1df2fa7d0748b23d16ae79a77fe47ab567499d756ca2",
  #"19844762591bc13bf7935a8f7c8b47bed1ddb0af049c41a66af147df90b9d535",
  #"39b2612f1649a23e2f34b03dd0718a5032f70d8278038c56de7104fc4e17fd05",
  #"69cc3b380826c14fbfdf77ef2aadf51186d32c40bfa94e79ed7e361dacda2f6d",
  #"4917d61d8ea40ed3948c5289327dcb3f341b872d193f87340f825d449d83570c",
  #"624016f2defd51d6a705a457c9ee9d02668314e1fbdc05135288f72f3491aec4",
  #"f9f4ebfc1f0e856794480156291cccb23bc9329acef765eefef5069e447d93e5",
  #"cbddca5fe24099bdf25787c3a9be981bacf2c3617b9f567ea7ad255025c43718",
  #"82818ba6e8c63b926b78a3d52d18f66fa1ba0b6391c12be8d1138b98a56ced47",
]

test cs_d10_leaf_insert_a() {
  insert_ok_a(d10_leaf_old, d10_leaf_new, d10_leaf_key, Leaf(#"2a8538946c50499376133b334ffd23d664073349bfe4b52fba61754f4e96a7db"), d10_leaf_sibs)
}

test cs_d10_leaf_insert_b() {
  insert_ok_b(d10_leaf_old, d10_leaf_new, d10_leaf_key, Leaf(#"2a8538946c50499376133b334ffd23d664073349bfe4b52fba61754f4e96a7db"), d10_leaf_rev, 10)
}

test cs_d10_leaf_absent_a() {
  absent_ok_a(d10_leaf_old, d10_leaf_key, Leaf(#"2a8538946c50499376133b334ffd23d664073349bfe4b52fba61754f4e96a7db"), d10_leaf_sibs)
}

test cs_d10_leaf_bogus_new_a() fail {
  insert_ok_a(d10_leaf_old, d10_leaf_bogus, d10_leaf_key, Leaf(#"2a8538946c50499376133b334ffd23d664073349bfe4b52fba61754f4e96a7db"), d10_leaf_sibs)
}

test cs_d10_leaf_bogus_new_b() fail {
  insert_ok_b(d10_leaf_old, d10_leaf_bogus, d10_leaf_key, Leaf(#"2a8538946c50499376133b334ffd23d664073349bfe4b52fba61754f4e96a7db"), d10_leaf_rev, 10)
}

const d20_leaf_key: ByteArray = #"3de7b047ff5492a512cb5e46120b55855a5cdab44b04a17fd91b3d957f338310"
const d20_leaf_old: ByteArray = #"13025f20a9dba2a5bcf5e2019d3c1987e1f11cbc4d061bcee82a6bdae73125ac"
const d20_leaf_new: ByteArray = #"9eb06a79381ce38e6c0530b82dfef208756942af80464b90b98e608f8741cea7"
const d20_leaf_bogus: ByteArray = #"e9bec4de44eca82e2005908a68ddec43444cce35aa07038416731263b51cbb42"

const d20_leaf_sibs: List<ByteArray> = [
  #"0524f44f7b775e430afc7ed0c0b47b22537fde369036761f27cd7ad87cb8d714",
  #"11b140027e8aee21fe9a24f4ff0dc4d17f3711b326d8f44c8c5e6f6db91d7ef8",
  #"a450c74fb19d6d4bb2511167be33065484df81810a421b0720a62573f16f154a",
  #"2297e8c9e446419aa84ae662fdc4d54feed171dba385e4afa8733332b6684565",
  #"8e54a5a0882048cc1c410620410e7f93ad4194f3ceccf36fb497901c44119166",
  #"bbf060331681d2039175cee093883d79ea109e26c0ee914f1a891a4cc2eca955",
  #"e98d55def8a0416896bfb78a5c10d08f37dc19826c00ad26d2ec99c013325d33",
  #"c2e041ff96fb7bb5ad96b85d3c25401ed1e782a0997f6624ae778f8974350591",
  #"711469be38289e38d1a668d50d6009ef8947582310cd152bfbb3810ad9de21e1",
  #"e53fca55b1c6a1240b8ec9a1c6a297d08a6781dd6e6c058622c136c96466eefe",
  #"80aa1a5b7b701c416693953a7372323d226cfd825b21d5412282d2e10e1730f3",
  #"56803c2c31646e9e62ab1ed66f31a5028076df1baf9a0e26706a9160625db4e9",
  #"b2cd598a0c364cdc85a48b4d9c0b15bfb68b3bb8049bfdffcc378f08ece14d1c",
  #"ad3ddd237b3055edf5ec6c4dfe0b05f42e2e883256e16e83ebd215772eadfb9c",
  #"223ad716fb5451e9c3676690db70922a36c53f067a544b08bd3e9783f302c442",
  #"1fc18411a2cb3735181ed8827e3199c902381956dde40a0862b7394d8ff07f98",
  #"e9b264847332a4f2a8139fabc778f26431af9ee30e49caa8321847442c1f9139",
  #"65fcdd81d37b0c12a384357254163dc4d6d53f78e0aee5fa3f24458e3150969b",
  #"828f4aa128abd29c8ff6e5f3a2acb8918fd11b6c9bcd26ebacfe07275f5c37c0",
  #"b46fe934c161ce735e2a2b118a220932f8fd08f99ce8c6864e42a628f782468b",
]
const d20_leaf_rev: List<ByteArray> = [
  #"b46fe934c161ce735e2a2b118a220932f8fd08f99ce8c6864e42a628f782468b",
  #"828f4aa128abd29c8ff6e5f3a2acb8918fd11b6c9bcd26ebacfe07275f5c37c0",
  #"65fcdd81d37b0c12a384357254163dc4d6d53f78e0aee5fa3f24458e3150969b",
  #"e9b264847332a4f2a8139fabc778f26431af9ee30e49caa8321847442c1f9139",
  #"1fc18411a2cb3735181ed8827e3199c902381956dde40a0862b7394d8ff07f98",
  #"223ad716fb5451e9c3676690db70922a36c53f067a544b08bd3e9783f302c442",
  #"ad3ddd237b3055edf5ec6c4dfe0b05f42e2e883256e16e83ebd215772eadfb9c",
  #"b2cd598a0c364cdc85a48b4d9c0b15bfb68b3bb8049bfdffcc378f08ece14d1c",
  #"56803c2c31646e9e62ab1ed66f31a5028076df1baf9a0e26706a9160625db4e9",
  #"80aa1a5b7b701c416693953a7372323d226cfd825b21d5412282d2e10e1730f3",
  #"e53fca55b1c6a1240b8ec9a1c6a297d08a6781dd6e6c058622c136c96466eefe",
  #"711469be38289e38d1a668d50d6009ef8947582310cd152bfbb3810ad9de21e1",
  #"c2e041ff96fb7bb5ad96b85d3c25401ed1e782a0997f6624ae778f8974350591",
  #"e98d55def8a0416896bfb78a5c10d08f37dc19826c00ad26d2ec99c013325d33",
  #"bbf060331681d2039175cee093883d79ea109e26c0ee914f1a891a4cc2eca955",
  #"8e54a5a0882048cc1c410620410e7f93ad4194f3ceccf36fb497901c44119166",
  #"2297e8c9e446419aa84ae662fdc4d54feed171dba385e4afa8733332b6684565",
  #"a450c74fb19d6d4bb2511167be33065484df81810a421b0720a62573f16f154a",
  #"11b140027e8aee21fe9a24f4ff0dc4d17f3711b326d8f44c8c5e6f6db91d7ef8",
  #"0524f44f7b775e430afc7ed0c0b47b22537fde369036761f27cd7ad87cb8d714",
]

test cs_d20_leaf_insert_a() {
  insert_ok_a(d20_leaf_old, d20_leaf_new, d20_leaf_key, Leaf(#"3de7bb1e8b6ec8338c0affc3a719fb14b996bdfd43cd6ca023f89c0268064a28"), d20_leaf_sibs)
}

test cs_d20_leaf_insert_b() {
  insert_ok_b(d20_leaf_old, d20_leaf_new, d20_leaf_key, Leaf(#"3de7bb1e8b6ec8338c0affc3a719fb14b996bdfd43cd6ca023f89c0268064a28"), d20_leaf_rev, 20)
}

test cs_d20_leaf_absent_a() {
  absent_ok_a(d20_leaf_old, d20_leaf_key, Leaf(#"3de7bb1e8b6ec8338c0affc3a719fb14b996bdfd43cd6ca023f89c0268064a28"), d20_leaf_sibs)
}

test cs_d20_leaf_bogus_new_a() fail {
  insert_ok_a(d20_leaf_old, d20_leaf_bogus, d20_leaf_key, Leaf(#"3de7bb1e8b6ec8338c0affc3a719fb14b996bdfd43cd6ca023f89c0268064a28"), d20_leaf_sibs)
}

test cs_d20_leaf_bogus_new_b() fail {
  insert_ok_b(d20_leaf_old, d20_leaf_bogus, d20_leaf_key, Leaf(#"3de7bb1e8b6ec8338c0affc3a719fb14b996bdfd43cd6ca023f89c0268064a28"), d20_leaf_rev, 20)
}

test cs_d20_leaf_neg_key_present_as_leaf() fail {
  insert_ok_b(d20_leaf_old, d20_leaf_new, d20_leaf_key, Leaf(d20_leaf_key), d20_leaf_rev, 20)
}

test cs_d20_leaf_neg_claim_empty() fail {
  insert_ok_b(d20_leaf_old, d20_leaf_new, d20_leaf_key, Empty, d20_leaf_rev, 20)
}

test cs_d20_leaf_neg_wrong_d() fail {
  insert_ok_b(d20_leaf_old, d20_leaf_new, d20_leaf_key, Leaf(#"3de7bb1e8b6ec8338c0affc3a719fb14b996bdfd43cd6ca023f89c0268064a28"), d20_leaf_rev, 21)
}

test cs_d20_leaf_neg_truncated() fail {
  insert_ok_b(d20_leaf_old, d20_leaf_new, d20_leaf_key, Leaf(#"3de7bb1e8b6ec8338c0affc3a719fb14b996bdfd43cd6ca023f89c0268064a28"), list.drop(d20_leaf_rev, 1), 20)
}

const d27_leaf_key: ByteArray = #"911df2f16eb3aa2bc96aea9acf21c5650caf42cba4e789291dd34f775cea6e4d"
const d27_leaf_old: ByteArray = #"68b546d8faf5e100e45604ec9c7e457dd5b1a41bcca013b9aba31566fa935e56"
const d27_leaf_new: ByteArray = #"7bce725d9e6ef7e414c15b6a3293b867dee637a61cd4e42b62981a2b79f64f80"
const d27_leaf_bogus: ByteArray = #"70ddd05dbbb42e3ea564a88a36a3c4cb6417e4e2d4d9eb00e142c3f95fb91d47"

const d27_leaf_sibs: List<ByteArray> = [
  #"01c6ba8f173cde139bb264e2e0fddfabe5ee8cc04fbccf32bac34f625b78bd62",
  #"d6b9dc4e64d034fe1cd7f15e354bca40209e3092b8e21c5711d35d4eb1509738",
  #"30029a4edb75f1b958b63eeeabcb0b2b16777c3220ba02b6d064b417ebc50bb7",
  #"428ea08e7b3bfeeabc594da2ffdc054bb4b03fcde79b20d61c8c6b5ea59a333f",
  #"b789e71ce95d09a68bcb63e3a1c05394090b9eeebb2ed4d26edd36577ba8b8f1",
  #"a07f9ba6a2866fd25a1a35d1a3b9cac9eaa454a2b95b9e01b3a9327b59f799dc",
  #"d0d7814d0ec14641eecfd3dbf9220c13fec863f2d5816c0fd23e8b8da581e511",
  #"fbf1490233d3bd3871269fe34eb6ca6825a1a49558ada1a2dcf3533620ed9c36",
  #"e5ab3eff9945709110a43edf2779b21d6ddeeaa1e7b421c8b10285288d518e66",
  #"726ce4e79147f725aa5d9b0770227c54bbabbe915769735f44df9377f54ad455",
  #"f1be78c02594e34e5b0b037b9913976aa2b72aaa280ce1d6473b0d045599b2ae",
  #"356c4ff22fdbf1d01686b4ec585fe0b55fc960a19f2a613548479389158f79c9",
  #"bdc248d4e4a840093b15066b3c8ee74aa5ed84588157e92a090cfc5c787d0039",
  #"53c7fdff8881c50ba507fcdb1e94fd23c71a7f279d8f7d2e46b76cfad1364f40",
  #"637d90bf7da6f2c282e2a30799270a02e788bd333b6a9a8fe71dc804b539081f",
  #"f731b953e1eaeefab77f5764837a1337fa3b00ab4166b02ebe2bfe9166fb3610",
  #"34328a10ca73100d41db435baf568b8c05c2435cd414be3a0c7305232aeb5ca9",
  #"c1bde4b319cfe0ce023fd00fed004efa40f24a0706d9434f8d394536984f52d6",
  #"363fe1d224333076aa7d4799383af2355e374bfc2c07de7a4a107a204940083d",
  #"82564d5891089aafd7729971d0618a69d435c344316e523986db0280f45ee831",
  #"92afbd5f046a7b70c67b4deb9a1b88ac25b0f2bba72749afb322cb1669d61255",
  #"3a67f20d7620e7b20f5fdf7343f4ef8c9b21c260905c8e85632e41b381c731b0",
  #"f56125bd07000a1f38763bde7c6544cf5893f7825db661dc39563ddf2e3534aa",
  #"e731057c6f881011e0eaa12c4200015d9b68c6c370d661a3618118388b3ec6f6",
  #"24150e11b08ec099148a7689e98b3b89a2004be7dd547388b30611962072c0ba",
  #"49d8aff26096b7244e5d466847b2a975773454825954ceb67e95e96e859b73b5",
  #"a760484feeb5459458f9c9b5b0e580426848f5e5f81e49573debcc6fd35fdb02",
]
const d27_leaf_rev: List<ByteArray> = [
  #"a760484feeb5459458f9c9b5b0e580426848f5e5f81e49573debcc6fd35fdb02",
  #"49d8aff26096b7244e5d466847b2a975773454825954ceb67e95e96e859b73b5",
  #"24150e11b08ec099148a7689e98b3b89a2004be7dd547388b30611962072c0ba",
  #"e731057c6f881011e0eaa12c4200015d9b68c6c370d661a3618118388b3ec6f6",
  #"f56125bd07000a1f38763bde7c6544cf5893f7825db661dc39563ddf2e3534aa",
  #"3a67f20d7620e7b20f5fdf7343f4ef8c9b21c260905c8e85632e41b381c731b0",
  #"92afbd5f046a7b70c67b4deb9a1b88ac25b0f2bba72749afb322cb1669d61255",
  #"82564d5891089aafd7729971d0618a69d435c344316e523986db0280f45ee831",
  #"363fe1d224333076aa7d4799383af2355e374bfc2c07de7a4a107a204940083d",
  #"c1bde4b319cfe0ce023fd00fed004efa40f24a0706d9434f8d394536984f52d6",
  #"34328a10ca73100d41db435baf568b8c05c2435cd414be3a0c7305232aeb5ca9",
  #"f731b953e1eaeefab77f5764837a1337fa3b00ab4166b02ebe2bfe9166fb3610",
  #"637d90bf7da6f2c282e2a30799270a02e788bd333b6a9a8fe71dc804b539081f",
  #"53c7fdff8881c50ba507fcdb1e94fd23c71a7f279d8f7d2e46b76cfad1364f40",
  #"bdc248d4e4a840093b15066b3c8ee74aa5ed84588157e92a090cfc5c787d0039",
  #"356c4ff22fdbf1d01686b4ec585fe0b55fc960a19f2a613548479389158f79c9",
  #"f1be78c02594e34e5b0b037b9913976aa2b72aaa280ce1d6473b0d045599b2ae",
  #"726ce4e79147f725aa5d9b0770227c54bbabbe915769735f44df9377f54ad455",
  #"e5ab3eff9945709110a43edf2779b21d6ddeeaa1e7b421c8b10285288d518e66",
  #"fbf1490233d3bd3871269fe34eb6ca6825a1a49558ada1a2dcf3533620ed9c36",
  #"d0d7814d0ec14641eecfd3dbf9220c13fec863f2d5816c0fd23e8b8da581e511",
  #"a07f9ba6a2866fd25a1a35d1a3b9cac9eaa454a2b95b9e01b3a9327b59f799dc",
  #"b789e71ce95d09a68bcb63e3a1c05394090b9eeebb2ed4d26edd36577ba8b8f1",
  #"428ea08e7b3bfeeabc594da2ffdc054bb4b03fcde79b20d61c8c6b5ea59a333f",
  #"30029a4edb75f1b958b63eeeabcb0b2b16777c3220ba02b6d064b417ebc50bb7",
  #"d6b9dc4e64d034fe1cd7f15e354bca40209e3092b8e21c5711d35d4eb1509738",
  #"01c6ba8f173cde139bb264e2e0fddfabe5ee8cc04fbccf32bac34f625b78bd62",
]

test cs_d27_leaf_insert_a() {
  insert_ok_a(d27_leaf_old, d27_leaf_new, d27_leaf_key, Leaf(#"911df2e4c76251a1f612027e8d76f5e408a5b4b827befc32af2ece25a58e534c"), d27_leaf_sibs)
}

test cs_d27_leaf_insert_b() {
  insert_ok_b(d27_leaf_old, d27_leaf_new, d27_leaf_key, Leaf(#"911df2e4c76251a1f612027e8d76f5e408a5b4b827befc32af2ece25a58e534c"), d27_leaf_rev, 27)
}

test cs_d27_leaf_absent_a() {
  absent_ok_a(d27_leaf_old, d27_leaf_key, Leaf(#"911df2e4c76251a1f612027e8d76f5e408a5b4b827befc32af2ece25a58e534c"), d27_leaf_sibs)
}

test cs_d27_leaf_bogus_new_a() fail {
  insert_ok_a(d27_leaf_old, d27_leaf_bogus, d27_leaf_key, Leaf(#"911df2e4c76251a1f612027e8d76f5e408a5b4b827befc32af2ece25a58e534c"), d27_leaf_sibs)
}

test cs_d27_leaf_bogus_new_b() fail {
  insert_ok_b(d27_leaf_old, d27_leaf_bogus, d27_leaf_key, Leaf(#"911df2e4c76251a1f612027e8d76f5e408a5b4b827befc32af2ece25a58e534c"), d27_leaf_rev, 27)
}

test cs_d27_leaf_data_encode_only() {
  let x: Data = d27_leaf_sibs
  x != x || True
}

test cs_d27_leaf_data_encode_decode() {
  let x: Data = d27_leaf_sibs
  expect back: List<ByteArray> = x
  list.length(back) == 27
}

const d27_empty_key: ByteArray = #"32ec0934514ac00485af01de241acd3919091a0f64c8b465e1eed203e0ad4d75"
const d27_empty_old: ByteArray = #"dfece7706fcec58cac2f78b8d89cc019f0f7f696f0681d289da497dedc22b9b1"
const d27_empty_new: ByteArray = #"250dd5aefd9caebbb3e4bbd3fde6595f87e89c8b47bb9a23d9f09f6fbe4c0b42"
const d27_empty_bogus: ByteArray = #"e1fb21059d9bcf505ae6edbca8cf51e0282d6aed5d94118a468a78c2be18ec59"

const d27_empty_sibs: List<ByteArray> = [
  #"6eb7277c56c039af932bee536b9c0267ccc4cbd00be235a91c67e2c77ad83864",
  #"0e65f0098db182329e366fdf4ca37e032063f9600c1306cbb627620dafd554bb",
  #"1c57194b2e86a5982ec140b1bdfb69469af2e1b617721fac296b90b3bed9bf50",
  #"b98ee9ec49d42bb4a71d96868701af63aaf0bcfcec677d0fe459ba8f8b2533a0",
  #"942141077b572e4d63eef26ff3110dfb7e240458e81947736d6b0137a2372a88",
  #"cb85c8ec9e954bc668aac34e87d7874818ea950185e363fd850910820e7f38a2",
  #"fb1f75aedaa686d2984356ef8a364424f759d220e5ecc859153231a6735d6e69",
  #"1a0299519ce0886a1e2874b21615f5947607e6f4f7779aa7cdff1702f4c9274c",
  #"be571f83e1367ed84d1de7877a17cb378a9d123089e4f4f9b6d738170da333c5",
  #"4dd5be8f855de2e20bfc7234baf8767b9a72cde267e2dceaf1e92eec620376f2",
  #"82e6141aef4e639ab9351139e72c47050f6c33b394d34e57859c700b06223e31",
  #"e00c7a577e99a8b204cf526901930c009cf63ca27b780a474fc7585331aaac97",
  #"afb629964b48356df077adcc5e502da7e342da093cca337da851bb1121b0225f",
  #"1401f76cfe0e60791a00ccecca463b236064fb2e3cb164fb081df6e39fba8aba",
  #"596b54762a0b3acaf509f35edf2be4ecc6fd8670810a982f38d5fcc401213275",
  #"e587d5fe595e4fe33423dfe4107b7c39da999664937ab9b8b0866b64e17e010c",
  #"93967da3663065c906fbb4e3b8fd0dd53b51a07c42ac27da759949a0978c9944",
  #"b443ae5ae5f5b9d6442802325efdff33240dc25a1bc14c5c47131eec6587ee68",
  #"a3b5dc5d1d659fc00882887970b1c7359540f696c1ab785dffe2992055616c56",
  #"2f50485528c0452c88761c8a248c5f28832a2bcbbeec00fe61da824f4a57df2e",
  #"5d7ef3e2702bbdbd4b0549770d3916b2739e50391af733e95675689938a08b1b",
  #"c98f936e6501ace566127329dc845ac14dccd35846cbffe8377ddb07fd208c1b",
  #"0d4ba0ce298e6427613b53bbec2644205db409ccb67568342a07a29912b4623a",
  #"a222134d3671ddc46c6919873296862698b502a539cf7df59eab16a1c07b699d",
  #"655322b5941569984d044daeba0303058b256e459fb64c2e718eac48847b38f7",
  #"35801d5d0eff1c1089101c66e61e556ae2584dcebd07682172ae4c3be0f68a40",
  #"5aa6ef273b5f7113f865a7d577170621e24752fb10d7eeccb921ae9da630f5ac",
]
const d27_empty_rev: List<ByteArray> = [
  #"5aa6ef273b5f7113f865a7d577170621e24752fb10d7eeccb921ae9da630f5ac",
  #"35801d5d0eff1c1089101c66e61e556ae2584dcebd07682172ae4c3be0f68a40",
  #"655322b5941569984d044daeba0303058b256e459fb64c2e718eac48847b38f7",
  #"a222134d3671ddc46c6919873296862698b502a539cf7df59eab16a1c07b699d",
  #"0d4ba0ce298e6427613b53bbec2644205db409ccb67568342a07a29912b4623a",
  #"c98f936e6501ace566127329dc845ac14dccd35846cbffe8377ddb07fd208c1b",
  #"5d7ef3e2702bbdbd4b0549770d3916b2739e50391af733e95675689938a08b1b",
  #"2f50485528c0452c88761c8a248c5f28832a2bcbbeec00fe61da824f4a57df2e",
  #"a3b5dc5d1d659fc00882887970b1c7359540f696c1ab785dffe2992055616c56",
  #"b443ae5ae5f5b9d6442802325efdff33240dc25a1bc14c5c47131eec6587ee68",
  #"93967da3663065c906fbb4e3b8fd0dd53b51a07c42ac27da759949a0978c9944",
  #"e587d5fe595e4fe33423dfe4107b7c39da999664937ab9b8b0866b64e17e010c",
  #"596b54762a0b3acaf509f35edf2be4ecc6fd8670810a982f38d5fcc401213275",
  #"1401f76cfe0e60791a00ccecca463b236064fb2e3cb164fb081df6e39fba8aba",
  #"afb629964b48356df077adcc5e502da7e342da093cca337da851bb1121b0225f",
  #"e00c7a577e99a8b204cf526901930c009cf63ca27b780a474fc7585331aaac97",
  #"82e6141aef4e639ab9351139e72c47050f6c33b394d34e57859c700b06223e31",
  #"4dd5be8f855de2e20bfc7234baf8767b9a72cde267e2dceaf1e92eec620376f2",
  #"be571f83e1367ed84d1de7877a17cb378a9d123089e4f4f9b6d738170da333c5",
  #"1a0299519ce0886a1e2874b21615f5947607e6f4f7779aa7cdff1702f4c9274c",
  #"fb1f75aedaa686d2984356ef8a364424f759d220e5ecc859153231a6735d6e69",
  #"cb85c8ec9e954bc668aac34e87d7874818ea950185e363fd850910820e7f38a2",
  #"942141077b572e4d63eef26ff3110dfb7e240458e81947736d6b0137a2372a88",
  #"b98ee9ec49d42bb4a71d96868701af63aaf0bcfcec677d0fe459ba8f8b2533a0",
  #"1c57194b2e86a5982ec140b1bdfb69469af2e1b617721fac296b90b3bed9bf50",
  #"0e65f0098db182329e366fdf4ca37e032063f9600c1306cbb627620dafd554bb",
  #"6eb7277c56c039af932bee536b9c0267ccc4cbd00be235a91c67e2c77ad83864",
]

test cs_d27_empty_insert_a() {
  insert_ok_a(d27_empty_old, d27_empty_new, d27_empty_key, Empty, d27_empty_sibs)
}

test cs_d27_empty_insert_b() {
  insert_ok_b(d27_empty_old, d27_empty_new, d27_empty_key, Empty, d27_empty_rev, 27)
}

test cs_d27_empty_absent_a() {
  absent_ok_a(d27_empty_old, d27_empty_key, Empty, d27_empty_sibs)
}

test cs_d27_empty_bogus_new_a() fail {
  insert_ok_a(d27_empty_old, d27_empty_bogus, d27_empty_key, Empty, d27_empty_sibs)
}

test cs_d27_empty_bogus_new_b() fail {
  insert_ok_b(d27_empty_old, d27_empty_bogus, d27_empty_key, Empty, d27_empty_rev, 27)
}

const d33_leaf_key: ByteArray = #"c432569bf8d7a9db0ce5887692d1fe86517a1708e8c34ba5901d1a484648f4f3"
const d33_leaf_old: ByteArray = #"ce84895464c217edf272de7c148cfc467c765d5915f8452c634f90372e281ecc"
const d33_leaf_new: ByteArray = #"c52315033ea6037d3a007f17e747a02e334f9e07174c1e7a4245e21350330d51"
const d33_leaf_bogus: ByteArray = #"84d1ecca42b23dfa273e2d13446478f52bd5dba4df57989a26132d1a24581c65"

const d33_leaf_sibs: List<ByteArray> = [
  #"ab3e496e6b051f1fdaa3f30d0b7915552cc2d9b08e1c500d8d8722f9d61b9d3e",
  #"146d2e62774caadc6ca9916ed35e77052d76273cf7d38522d0ec0dd73fa777f2",
  #"6193938c0305d8aa40e3c284d4de00056a6822f774ce3f3509f140ca833fe79b",
  #"e3b5d4aeaf72842408d370da30ccbe8f3023765fe5a72ec4e532a84f84f27425",
  #"e96dba99802565de3d9951e516c12b9788364b3b3ee05ca750781619c9a6eb9c",
  #"7b9702bfabccbd246053bbe13a86828c78e22ac38f9da4dffe9effde022e721c",
  #"85fde65fd48f588b15677a8db67cfa70f20e859a575ceb70f1561f3efa0c80ff",
  #"43c7083827a7b8610b57c63ce5fc8ae98aa518c50e1fadf9ba67416ddfe248f8",
  #"557033051dd6d4ea3e1ca90fe3642b717abf377cbfd3475680ec05c49de8b891",
  #"5c624df24a418155fe8c16496241fefe67dcf72f7e68e36e39d05f54763d67f9",
  #"ea7a14ccb21e1c206a468bb2a8277004f939b647243883cafec7fcf66e80e4bc",
  #"1815141008d12fe42e0247a00b43f40dacdd8d1a5afc8eed0f14ccebed97d5d4",
  #"e2102b98a7ca4cdf582f1eb4b4f57568a44f0dfd504518669ce1aef06eba5a3b",
  #"b8e95492f4c05c7c92d387886b6fbb3d70251f15ddaa0edb4e45d35ccdf4499f",
  #"1e2812ae77a71f31ca4c6e5ec07b70c684ba4a74c0bcdd17eb680c218948419b",
  #"e86f1e042c92bac947ba4bae5471b2fa72ef7daf73bdfa9630df56675f331a08",
  #"8a23fbc24df1b26a57d8a545bfd4858f6cc228221763df4d58091f2f3f1b8839",
  #"6710fcf37ee930354f8c781174e8213032a9e99b460200c3ac2395aa7d1c16ae",
  #"fb160ed577c532c772df78d2edb2da71c805d5a300620e90cc88dab8efb63063",
  #"1f7f9c2c337f4b36fde93171bf9deb51ca77b1f38d7b8ca81bcb796e648f7ad6",
  #"1d32f8cf6e697534424f1435d4739a4725936d0fb2b1e3175523ed8cb3c37939",
  #"8b9f0402069fc0c080e8443901aa5bf63b52f98fed26f3e2f87e82e983d7104b",
  #"689b2cc14d7cbb38c3e265aafe27195c49c4aca16eea092f1ac9df3bb7aad3e3",
  #"7b662c6a00e75ee581c0ede1c6616f6f01e0585fad63834fb6da0af7b1aa7a6b",
  #"6f0e5826976d297d008a5315fff7b7b7d716e6589b8bac10ca204eb787af8fd2",
  #"4f44dee4377c91a4145cadd38a8cf73b9cc255df67b7fc93b8399488472a08e4",
  #"da26aa1ac6fbee0f3db939a11f9fd42fb4f08e42807efc92a56c35fa1a0b4cd7",
  #"28ad4143ec108ea4554b6a9e3f9afc71fdb28a621aaf5d19a3a2a596836d5e32",
  #"b64d885921b1fb8745e88dfb37aebd2be7cbdcba1e1d71a7cc13e228a5be576f",
  #"14e7b9b197ea50a984132ce8b2c2e3a502f7a1d733af27220e01d323fec2ee4c",
  #"f700faba5d3cb3f4b7127fe0a3ff92b04a1cff1716c07f9554f9170e1a01874b",
  #"d4b818b426fb255af4656b9ab2955dc085406adb03ddf6e9c8d02371c2ecefac",
  #"f6ddd3411296a0273f814ae163a9d271ca0957b010dc8df7f0195772eacd20ef",
]
const d33_leaf_rev: List<ByteArray> = [
  #"f6ddd3411296a0273f814ae163a9d271ca0957b010dc8df7f0195772eacd20ef",
  #"d4b818b426fb255af4656b9ab2955dc085406adb03ddf6e9c8d02371c2ecefac",
  #"f700faba5d3cb3f4b7127fe0a3ff92b04a1cff1716c07f9554f9170e1a01874b",
  #"14e7b9b197ea50a984132ce8b2c2e3a502f7a1d733af27220e01d323fec2ee4c",
  #"b64d885921b1fb8745e88dfb37aebd2be7cbdcba1e1d71a7cc13e228a5be576f",
  #"28ad4143ec108ea4554b6a9e3f9afc71fdb28a621aaf5d19a3a2a596836d5e32",
  #"da26aa1ac6fbee0f3db939a11f9fd42fb4f08e42807efc92a56c35fa1a0b4cd7",
  #"4f44dee4377c91a4145cadd38a8cf73b9cc255df67b7fc93b8399488472a08e4",
  #"6f0e5826976d297d008a5315fff7b7b7d716e6589b8bac10ca204eb787af8fd2",
  #"7b662c6a00e75ee581c0ede1c6616f6f01e0585fad63834fb6da0af7b1aa7a6b",
  #"689b2cc14d7cbb38c3e265aafe27195c49c4aca16eea092f1ac9df3bb7aad3e3",
  #"8b9f0402069fc0c080e8443901aa5bf63b52f98fed26f3e2f87e82e983d7104b",
  #"1d32f8cf6e697534424f1435d4739a4725936d0fb2b1e3175523ed8cb3c37939",
  #"1f7f9c2c337f4b36fde93171bf9deb51ca77b1f38d7b8ca81bcb796e648f7ad6",
  #"fb160ed577c532c772df78d2edb2da71c805d5a300620e90cc88dab8efb63063",
  #"6710fcf37ee930354f8c781174e8213032a9e99b460200c3ac2395aa7d1c16ae",
  #"8a23fbc24df1b26a57d8a545bfd4858f6cc228221763df4d58091f2f3f1b8839",
  #"e86f1e042c92bac947ba4bae5471b2fa72ef7daf73bdfa9630df56675f331a08",
  #"1e2812ae77a71f31ca4c6e5ec07b70c684ba4a74c0bcdd17eb680c218948419b",
  #"b8e95492f4c05c7c92d387886b6fbb3d70251f15ddaa0edb4e45d35ccdf4499f",
  #"e2102b98a7ca4cdf582f1eb4b4f57568a44f0dfd504518669ce1aef06eba5a3b",
  #"1815141008d12fe42e0247a00b43f40dacdd8d1a5afc8eed0f14ccebed97d5d4",
  #"ea7a14ccb21e1c206a468bb2a8277004f939b647243883cafec7fcf66e80e4bc",
  #"5c624df24a418155fe8c16496241fefe67dcf72f7e68e36e39d05f54763d67f9",
  #"557033051dd6d4ea3e1ca90fe3642b717abf377cbfd3475680ec05c49de8b891",
  #"43c7083827a7b8610b57c63ce5fc8ae98aa518c50e1fadf9ba67416ddfe248f8",
  #"85fde65fd48f588b15677a8db67cfa70f20e859a575ceb70f1561f3efa0c80ff",
  #"7b9702bfabccbd246053bbe13a86828c78e22ac38f9da4dffe9effde022e721c",
  #"e96dba99802565de3d9951e516c12b9788364b3b3ee05ca750781619c9a6eb9c",
  #"e3b5d4aeaf72842408d370da30ccbe8f3023765fe5a72ec4e532a84f84f27425",
  #"6193938c0305d8aa40e3c284d4de00056a6822f774ce3f3509f140ca833fe79b",
  #"146d2e62774caadc6ca9916ed35e77052d76273cf7d38522d0ec0dd73fa777f2",
  #"ab3e496e6b051f1fdaa3f30d0b7915552cc2d9b08e1c500d8d8722f9d61b9d3e",
]

test cs_d33_leaf_insert_a() {
  insert_ok_a(d33_leaf_old, d33_leaf_new, d33_leaf_key, Leaf(#"c432569bae6df920bbf2bdece97c7919359978195c1734360a16e5b9bdb3a4ec"), d33_leaf_sibs)
}

test cs_d33_leaf_insert_b() {
  insert_ok_b(d33_leaf_old, d33_leaf_new, d33_leaf_key, Leaf(#"c432569bae6df920bbf2bdece97c7919359978195c1734360a16e5b9bdb3a4ec"), d33_leaf_rev, 33)
}

test cs_d33_leaf_absent_a() {
  absent_ok_a(d33_leaf_old, d33_leaf_key, Leaf(#"c432569bae6df920bbf2bdece97c7919359978195c1734360a16e5b9bdb3a4ec"), d33_leaf_sibs)
}

test cs_d33_leaf_bogus_new_a() fail {
  insert_ok_a(d33_leaf_old, d33_leaf_bogus, d33_leaf_key, Leaf(#"c432569bae6df920bbf2bdece97c7919359978195c1734360a16e5b9bdb3a4ec"), d33_leaf_sibs)
}

test cs_d33_leaf_bogus_new_b() fail {
  insert_ok_b(d33_leaf_old, d33_leaf_bogus, d33_leaf_key, Leaf(#"c432569bae6df920bbf2bdece97c7919359978195c1734360a16e5b9bdb3a4ec"), d33_leaf_rev, 33)
}

const d40_leaf_key: ByteArray = #"c69ba745ebd1bf9f17b72764bf3ba5a833430f3f8c83254ad41b08b8573bfbc9"
const d40_leaf_old: ByteArray = #"0860503d05cb95309b9dfb83a50fd31bd024d287f11eed3ffabffe0001e7e9ab"
const d40_leaf_new: ByteArray = #"22b538491d24f0927b2cae2b3e2c8d14726a20679edb01edb27166028fc0978c"
const d40_leaf_bogus: ByteArray = #"5d433fa0647e49719acbbd4d4eb07be74a1f8ec1de94d187c7343f38c8f37972"

const d40_leaf_sibs: List<ByteArray> = [
  #"b0afe1d05d838585a13742b2e7baf4ad58aad2c364abcca363a71b0b6ab0b8e4",
  #"c8d5fe4eaba5dc47f1e58c3f96044b4754b02f2a557ec47c48dcd2be54640c6f",
  #"d49dc72054d1e84ce2d3c5cae23e0dd688f328c5ce54608c8a6d05afa3dd841a",
  #"c92c223ce5c2158b9fe417068f601a4c27759cf178007f39e524529ebd81c42d",
  #"9f7193497497700a93f5e93ac4b21926938cbef473db069b720ad6571237125d",
  #"87c719d87a9766eebc6b6179b0e9a8ef8d151945d4b9882f92e0b8bbe8dd1508",
  #"48687e7eb6a9d2eaef6e4a8485ce5e0d5ff4b1e3db628df95ae5be0583f8616a",
  #"f91c1c6600c2c9919b4d38a7f80a9f2a19a10f5007a825cec55c44892ce85ca3",
  #"0ba006a0dc307ad8f1b2aaddf14b4c9a075e5eb87e5eea32114643f77a975aa2",
  #"82fd694458208777c4d1a95253534a408849b81030bae6074e5bd242cabdfda3",
  #"0ed6cddfc129d7fd4c6f2911755faadb87ac2a3cbf6b0e3dba0b194561c700bc",
  #"5ddd6dea3646fc3e268a097c1e1dc8492b79fce8b30537fada1de26c2cafbf2d",
  #"302c2ae5436874cc25c7e8f9af904a2232cafbfcda58f046c904ff299b09faef",
  #"0eaf7fbd50c1ae6cdd109bfdf025e6c453413068721f666791f7870dc2ea37df",
  #"7ff6887caa4dee9251eb943f8d7d53e7cf8362c8f4925607d716d4ae8acb1e37",
  #"49a0207c0a31d8668e0436ce68bd16c9b7e5d482af74d76c190b80f0a79ec87c",
  #"3e7e0d20f2efe941af61c29463cba8b2590f6b807e1fe388ccceb1520a1a70ab",
  #"e51184acca2724735f18457a4b18f265174f5e76687111ab19251a083aeaeda5",
  #"308bd1a9c0ee996022c6004064c1adbe8a3fec9f1e6bd759458d9ca0ab4f7240",
  #"6daed9c8647275cf991167b74a70eaa59d4cc557e8aa6f2ca2b5ea2680ed4d6e",
  #"b7a0bdc5c05e6c6bf03a61df8408807525dbe8369fc933b91bf7359035d5047d",
  #"e0b293d8bcb45e1d2dbe4bd6bc882770912cf6bcc0903892dcaeaddb20ee6185",
  #"240a40987b0ca9e1cc41e08fea590d2dc18f57f3c71baa98b72eadd27b28654a",
  #"d67daa4af839ac61987b0dae2c265130c2fb8d9c54c141f3d9e9a09dc1f2c17b",
  #"f6ac47732f33c27f96cfca28a2e69e065ec2d121bf24032ed6e14f556b925006",
  #"fc05672de002b461aa2ceb09f3321248f25b74c50afb396ebcd236be2b1a1777",
  #"91ddbc710746d3e9a56d5fc19227f6aa4dfdb8946b2e628d93895874900b252e",
  #"0009cd96f9066f93373eed63064eceaacfb7db8ff0b0c25094b5c3bdaf77f7d8",
  #"060b22b415c67badfe84a3a37c301e29aeb7e63976c95590b5f9cd79e0644c93",
  #"48bdb8279d3984a0d3cb731aab933bf5500f2b97cd83ae24e9838a6bca2645b0",
  #"ab217a30206ef445335f2b42219f3ff20787ee857136fc688b553c232c1743b8",
  #"e22d556aa6343ae822a3738fda0c12453ebee30c4d6eb29069ce14112f7ef39a",
  #"96d22391fd5368b37d027b9a7b3bcc11f7e49811c65083bd303b57ab0358e93a",
  #"5185ea19b496cbf065da375476836841ab4b082b6eb2398dcf4d80b4b1b6bd6b",
  #"5ae5c587c51118186d9236784553142868478a0bfe17fbdfeeafb477d7e0e369",
  #"42298f4661773297fc7d1729a60808d230547199be57823e138be3ff21200c61",
  #"21105b15188418bcf1ca4dde0c57e5ab9336f4be27e70ab96cfce3ba76a3a924",
  #"2653e56f38f962c2e5e42d013ff23389e74bff61bf31539fa49c3c67e0765c18",
  #"88f3e473708d9ed894ec52225a70fee95a45c57d4937c0ce52acb3f0b3b31a49",
  #"a8f4d97fc528369ecd9aaffee62e0bc9ac092b70d0a6397578448cab79d3636a",
]
const d40_leaf_rev: List<ByteArray> = [
  #"a8f4d97fc528369ecd9aaffee62e0bc9ac092b70d0a6397578448cab79d3636a",
  #"88f3e473708d9ed894ec52225a70fee95a45c57d4937c0ce52acb3f0b3b31a49",
  #"2653e56f38f962c2e5e42d013ff23389e74bff61bf31539fa49c3c67e0765c18",
  #"21105b15188418bcf1ca4dde0c57e5ab9336f4be27e70ab96cfce3ba76a3a924",
  #"42298f4661773297fc7d1729a60808d230547199be57823e138be3ff21200c61",
  #"5ae5c587c51118186d9236784553142868478a0bfe17fbdfeeafb477d7e0e369",
  #"5185ea19b496cbf065da375476836841ab4b082b6eb2398dcf4d80b4b1b6bd6b",
  #"96d22391fd5368b37d027b9a7b3bcc11f7e49811c65083bd303b57ab0358e93a",
  #"e22d556aa6343ae822a3738fda0c12453ebee30c4d6eb29069ce14112f7ef39a",
  #"ab217a30206ef445335f2b42219f3ff20787ee857136fc688b553c232c1743b8",
  #"48bdb8279d3984a0d3cb731aab933bf5500f2b97cd83ae24e9838a6bca2645b0",
  #"060b22b415c67badfe84a3a37c301e29aeb7e63976c95590b5f9cd79e0644c93",
  #"0009cd96f9066f93373eed63064eceaacfb7db8ff0b0c25094b5c3bdaf77f7d8",
  #"91ddbc710746d3e9a56d5fc19227f6aa4dfdb8946b2e628d93895874900b252e",
  #"fc05672de002b461aa2ceb09f3321248f25b74c50afb396ebcd236be2b1a1777",
  #"f6ac47732f33c27f96cfca28a2e69e065ec2d121bf24032ed6e14f556b925006",
  #"d67daa4af839ac61987b0dae2c265130c2fb8d9c54c141f3d9e9a09dc1f2c17b",
  #"240a40987b0ca9e1cc41e08fea590d2dc18f57f3c71baa98b72eadd27b28654a",
  #"e0b293d8bcb45e1d2dbe4bd6bc882770912cf6bcc0903892dcaeaddb20ee6185",
  #"b7a0bdc5c05e6c6bf03a61df8408807525dbe8369fc933b91bf7359035d5047d",
  #"6daed9c8647275cf991167b74a70eaa59d4cc557e8aa6f2ca2b5ea2680ed4d6e",
  #"308bd1a9c0ee996022c6004064c1adbe8a3fec9f1e6bd759458d9ca0ab4f7240",
  #"e51184acca2724735f18457a4b18f265174f5e76687111ab19251a083aeaeda5",
  #"3e7e0d20f2efe941af61c29463cba8b2590f6b807e1fe388ccceb1520a1a70ab",
  #"49a0207c0a31d8668e0436ce68bd16c9b7e5d482af74d76c190b80f0a79ec87c",
  #"7ff6887caa4dee9251eb943f8d7d53e7cf8362c8f4925607d716d4ae8acb1e37",
  #"0eaf7fbd50c1ae6cdd109bfdf025e6c453413068721f666791f7870dc2ea37df",
  #"302c2ae5436874cc25c7e8f9af904a2232cafbfcda58f046c904ff299b09faef",
  #"5ddd6dea3646fc3e268a097c1e1dc8492b79fce8b30537fada1de26c2cafbf2d",
  #"0ed6cddfc129d7fd4c6f2911755faadb87ac2a3cbf6b0e3dba0b194561c700bc",
  #"82fd694458208777c4d1a95253534a408849b81030bae6074e5bd242cabdfda3",
  #"0ba006a0dc307ad8f1b2aaddf14b4c9a075e5eb87e5eea32114643f77a975aa2",
  #"f91c1c6600c2c9919b4d38a7f80a9f2a19a10f5007a825cec55c44892ce85ca3",
  #"48687e7eb6a9d2eaef6e4a8485ce5e0d5ff4b1e3db628df95ae5be0583f8616a",
  #"87c719d87a9766eebc6b6179b0e9a8ef8d151945d4b9882f92e0b8bbe8dd1508",
  #"9f7193497497700a93f5e93ac4b21926938cbef473db069b720ad6571237125d",
  #"c92c223ce5c2158b9fe417068f601a4c27759cf178007f39e524529ebd81c42d",
  #"d49dc72054d1e84ce2d3c5cae23e0dd688f328c5ce54608c8a6d05afa3dd841a",
  #"c8d5fe4eaba5dc47f1e58c3f96044b4754b02f2a557ec47c48dcd2be54640c6f",
  #"b0afe1d05d838585a13742b2e7baf4ad58aad2c364abcca363a71b0b6ab0b8e4",
]

test cs_d40_leaf_insert_a() {
  insert_ok_a(d40_leaf_old, d40_leaf_new, d40_leaf_key, Leaf(#"c69ba745eb3aaf336b391b53bebe6d8a9a987b558496ab1dd3ec69c6fff1730d"), d40_leaf_sibs)
}

test cs_d40_leaf_insert_b() {
  insert_ok_b(d40_leaf_old, d40_leaf_new, d40_leaf_key, Leaf(#"c69ba745eb3aaf336b391b53bebe6d8a9a987b558496ab1dd3ec69c6fff1730d"), d40_leaf_rev, 40)
}

test cs_d40_leaf_absent_a() {
  absent_ok_a(d40_leaf_old, d40_leaf_key, Leaf(#"c69ba745eb3aaf336b391b53bebe6d8a9a987b558496ab1dd3ec69c6fff1730d"), d40_leaf_sibs)
}

test cs_d40_leaf_bogus_new_a() fail {
  insert_ok_a(d40_leaf_old, d40_leaf_bogus, d40_leaf_key, Leaf(#"c69ba745eb3aaf336b391b53bebe6d8a9a987b558496ab1dd3ec69c6fff1730d"), d40_leaf_sibs)
}

test cs_d40_leaf_bogus_new_b() fail {
  insert_ok_b(d40_leaf_old, d40_leaf_bogus, d40_leaf_key, Leaf(#"c69ba745eb3aaf336b391b53bebe6d8a9a987b558496ab1dd3ec69c6fff1730d"), d40_leaf_rev, 40)
}

const d52_leaf_key: ByteArray = #"894bd5fb7968493f211441cd9d3555059e150da8af1468c5d8d877f63d7c0a90"
const d52_leaf_old: ByteArray = #"988d50ec1cded23e026042ce45e59be7862fe9f41779c2d003d32d443e539ee9"
const d52_leaf_new: ByteArray = #"381fbed42dd181fddcd42a87eeeb8031da61046ca56109af89cdc957dfb156ff"
const d52_leaf_bogus: ByteArray = #"0b0403a6eb38b7cf3abfc9ccd0943a2e58ad59eaab141511cb7266d9cb7a822c"

const d52_leaf_sibs: List<ByteArray> = [
  #"3b9ffa2e7ec1e54a58af3faa230ab2b8e090697e55342fd37118672fc014ce47",
  #"bfd9b96a66a230486e0e912fc6ee339ffb7d6e272aba462e1fb314bc0c30b22b",
  #"d8cffe65794390573b277afc494fb809fca1746d0e99071f3d2fa1e30c321dbc",
  #"cd802897eb6e5400ca839a2a2e31c66e1f680419b1419cec0a89e6e03fea041b",
  #"cae6ae00868cbc0fb8e5175589279a0d8074dc1c02e76f2b3c95799eefc49e54",
  #"6c31070c6ac058793d1924796cde5a00554df2fa66bbad595bee5c750fcf19d9",
  #"2220333d19041f848e6fd829adbaddbefc466f2a361f7a554ed74660fc95657f",
  #"4b8a777c1d63db58097cf436c9e3ba910b2cb39049e4a4bc87e5dedec823446b",
  #"6388aed6e08c7aaffb4be88273d392a81fbc74fedc72f56fe7e9d671b669eb44",
  #"b6c2c60648d0f3fa905df13f1ca81c1459c0942e50ea0bf2ae7db476ee7bc0e2",
  #"0cb3b2160e72faadd7570f2d9cbb97fb65c6f6615a08a79032243e30ae812786",
  #"9afcab37f361790dbecd60323b577413d0a749184380809819fecd6ec50b1e8e",
  #"459ca5e63f2cfe27784b18b6e8a1340d87b774591e98f4d19c08e5b5c94aede4",
  #"368fd4adb71a6be7bde7f93425e1e9b92b67ecddb0543dafb31037d2864fc8c3",
  #"8eee19999cd72a45badc7c5b6ad044d2a81764bbf7cd542a97f504e83eff35f3",
  #"6acb8da07e198212d853f1eac3fdea5aca035203d3605f97ee88052935075c8d",
  #"21ab4c8e2125a849934182e5c77470f1940616e546961aafe6400438ab9d188f",
  #"2b907d777b7f07ed8620cf32ee1277ac96a0bcb4b80c45a112c8864910c9fcd4",
  #"dce404d34ef4ea12cc6ac7140d1a64f73c6103f8252f5f4ba2fb75a3657f1a7e",
  #"2240cb73f76d6f523f80d89be112222de94fa654428770b6a67c60bf153dc642",
  #"f0b8a0d703d570d40dd78cf537b03ce724ff7b8b618b57ba7cc2c85c806970f0",
  #"b15d1013cf0622162b4d19a4eb3e97c6be4bb7164712db5855760243bcbba7ba",
  #"e95419a6cac944d9c036ed880347c100fbc91c69b074d6f39747a14d45c1d069",
  #"7935a6ea4ceba8702088f578a2e88390ac2b6a1f40c496aa85142031ce38e84c",
  #"9e6d67f37ae83c585041237278379f8281039fc78179ecd580105bc3a36fcbc7",
  #"31e58ad6f07cbba2af22095f530fc16486de85f2cf01fa0d5331f18e703ef89e",
  #"59f6759b876a6706edfb50ce188f3fae63a532216f5741ccc87e873412a43588",
  #"d591de5f4fee26c396845cece826ee5e986aa288ab88a70196496a693c3aaf89",
  #"0d9032e5dbe5e3aa03955c1ee8a0449d06f6c3bfb0f8f17da63437fc71a37857",
  #"39991e5e33540c9ccae03f411692dd211edbe3c5b7dfd317f6af663d4a669c52",
  #"d272f437bf3a7a006796045d6276b31f2bc0f7ea429c50a4f37aff473e618c3f",
  #"6932e592c2c3374cea45dfc077e95d1f5895f569d7031cc47f2ee97f0b035319",
  #"be84ee5d313d58b45abd9d612d64cf40f2e572dff792c84a2ba2cfe4e7326655",
  #"71a1b254291d5fda26e85d6ae8743b306d620108b82475b3a91600e4bb40f4c3",
  #"8f8941bd4e1925b73c2783cf88d5e5023829b689469a22fbb901c56ae8980137",
  #"e256aeaaccd6a2501b86a4c2a0aef5ffa8596ef9ce7c1189fe20bebdd758031d",
  #"cecb7a1e9469e90676627a3e0f145e5b8533c02b1a2079e9aa4992a97fdb9450",
  #"4bfd32d8a53f93817eaabad2eaab372a08cb1e133caf66e46f8fccc3c5b154a4",
  #"bac4aa52277ae5afca6dfc9e03fd6d4286e355e2b678eda3c2018588ca601639",
  #"a56de20f2b2ab765bb2544d1c8932f79f959465cc0492c654730eee02d0623e1",
  #"dba0b4e1d38d9c15019ad3a42f8290811082ec344d82b6d40c764bcbf880db39",
  #"7a47985b4c579b67acfa7759b0a70f7aa3ab45c61748762873e62aca2bf68495",
  #"9a07779c4e72d327b83a10c715153b2ec2d3bf475892a3a97cd6496f68054d76",
  #"c59d6ac1082a06c1077726e5d54331808506b3cbb546dfe4d6f8cfb1f0653ef7",
  #"a1c8711b260482bd1586eed590ccae05249a9d070caea0896216023e0a04366f",
  #"556e25919b949c601be426bcaf617442ac69a9e96ac29cfe09c9071eef7640f8",
  #"dca911ac5b134baa8986c5fe67f122f25b1816d390642b7883a0e1dbae932f54",
  #"2b0c1ffd2ae297c33f8241bc4bc6baa595aa16f33c791cbc80e5618a2e64165a",
  #"c8387ed507868b31c45cf187b1567343510cc4e735df84e3fe16a7fcc86a7dd7",
  #"ff07e1a4e158f6ab86430380ccc4db9782d905f031f2b2aa7a10f042c0cffa3a",
  #"ba2b0cd8c3ac66200e5447363ab7c7338c449399b3c26793a525b21d899d73c9",
  #"bffcf08d19e9f0d78d32b82bac002c7869eff870bc7448c3a0f1d510b7128610",
]
const d52_leaf_rev: List<ByteArray> = [
  #"bffcf08d19e9f0d78d32b82bac002c7869eff870bc7448c3a0f1d510b7128610",
  #"ba2b0cd8c3ac66200e5447363ab7c7338c449399b3c26793a525b21d899d73c9",
  #"ff07e1a4e158f6ab86430380ccc4db9782d905f031f2b2aa7a10f042c0cffa3a",
  #"c8387ed507868b31c45cf187b1567343510cc4e735df84e3fe16a7fcc86a7dd7",
  #"2b0c1ffd2ae297c33f8241bc4bc6baa595aa16f33c791cbc80e5618a2e64165a",
  #"dca911ac5b134baa8986c5fe67f122f25b1816d390642b7883a0e1dbae932f54",
  #"556e25919b949c601be426bcaf617442ac69a9e96ac29cfe09c9071eef7640f8",
  #"a1c8711b260482bd1586eed590ccae05249a9d070caea0896216023e0a04366f",
  #"c59d6ac1082a06c1077726e5d54331808506b3cbb546dfe4d6f8cfb1f0653ef7",
  #"9a07779c4e72d327b83a10c715153b2ec2d3bf475892a3a97cd6496f68054d76",
  #"7a47985b4c579b67acfa7759b0a70f7aa3ab45c61748762873e62aca2bf68495",
  #"dba0b4e1d38d9c15019ad3a42f8290811082ec344d82b6d40c764bcbf880db39",
  #"a56de20f2b2ab765bb2544d1c8932f79f959465cc0492c654730eee02d0623e1",
  #"bac4aa52277ae5afca6dfc9e03fd6d4286e355e2b678eda3c2018588ca601639",
  #"4bfd32d8a53f93817eaabad2eaab372a08cb1e133caf66e46f8fccc3c5b154a4",
  #"cecb7a1e9469e90676627a3e0f145e5b8533c02b1a2079e9aa4992a97fdb9450",
  #"e256aeaaccd6a2501b86a4c2a0aef5ffa8596ef9ce7c1189fe20bebdd758031d",
  #"8f8941bd4e1925b73c2783cf88d5e5023829b689469a22fbb901c56ae8980137",
  #"71a1b254291d5fda26e85d6ae8743b306d620108b82475b3a91600e4bb40f4c3",
  #"be84ee5d313d58b45abd9d612d64cf40f2e572dff792c84a2ba2cfe4e7326655",
  #"6932e592c2c3374cea45dfc077e95d1f5895f569d7031cc47f2ee97f0b035319",
  #"d272f437bf3a7a006796045d6276b31f2bc0f7ea429c50a4f37aff473e618c3f",
  #"39991e5e33540c9ccae03f411692dd211edbe3c5b7dfd317f6af663d4a669c52",
  #"0d9032e5dbe5e3aa03955c1ee8a0449d06f6c3bfb0f8f17da63437fc71a37857",
  #"d591de5f4fee26c396845cece826ee5e986aa288ab88a70196496a693c3aaf89",
  #"59f6759b876a6706edfb50ce188f3fae63a532216f5741ccc87e873412a43588",
  #"31e58ad6f07cbba2af22095f530fc16486de85f2cf01fa0d5331f18e703ef89e",
  #"9e6d67f37ae83c585041237278379f8281039fc78179ecd580105bc3a36fcbc7",
  #"7935a6ea4ceba8702088f578a2e88390ac2b6a1f40c496aa85142031ce38e84c",
  #"e95419a6cac944d9c036ed880347c100fbc91c69b074d6f39747a14d45c1d069",
  #"b15d1013cf0622162b4d19a4eb3e97c6be4bb7164712db5855760243bcbba7ba",
  #"f0b8a0d703d570d40dd78cf537b03ce724ff7b8b618b57ba7cc2c85c806970f0",
  #"2240cb73f76d6f523f80d89be112222de94fa654428770b6a67c60bf153dc642",
  #"dce404d34ef4ea12cc6ac7140d1a64f73c6103f8252f5f4ba2fb75a3657f1a7e",
  #"2b907d777b7f07ed8620cf32ee1277ac96a0bcb4b80c45a112c8864910c9fcd4",
  #"21ab4c8e2125a849934182e5c77470f1940616e546961aafe6400438ab9d188f",
  #"6acb8da07e198212d853f1eac3fdea5aca035203d3605f97ee88052935075c8d",
  #"8eee19999cd72a45badc7c5b6ad044d2a81764bbf7cd542a97f504e83eff35f3",
  #"368fd4adb71a6be7bde7f93425e1e9b92b67ecddb0543dafb31037d2864fc8c3",
  #"459ca5e63f2cfe27784b18b6e8a1340d87b774591e98f4d19c08e5b5c94aede4",
  #"9afcab37f361790dbecd60323b577413d0a749184380809819fecd6ec50b1e8e",
  #"0cb3b2160e72faadd7570f2d9cbb97fb65c6f6615a08a79032243e30ae812786",
  #"b6c2c60648d0f3fa905df13f1ca81c1459c0942e50ea0bf2ae7db476ee7bc0e2",
  #"6388aed6e08c7aaffb4be88273d392a81fbc74fedc72f56fe7e9d671b669eb44",
  #"4b8a777c1d63db58097cf436c9e3ba910b2cb39049e4a4bc87e5dedec823446b",
  #"2220333d19041f848e6fd829adbaddbefc466f2a361f7a554ed74660fc95657f",
  #"6c31070c6ac058793d1924796cde5a00554df2fa66bbad595bee5c750fcf19d9",
  #"cae6ae00868cbc0fb8e5175589279a0d8074dc1c02e76f2b3c95799eefc49e54",
  #"cd802897eb6e5400ca839a2a2e31c66e1f680419b1419cec0a89e6e03fea041b",
  #"d8cffe65794390573b277afc494fb809fca1746d0e99071f3d2fa1e30c321dbc",
  #"bfd9b96a66a230486e0e912fc6ee339ffb7d6e272aba462e1fb314bc0c30b22b",
  #"3b9ffa2e7ec1e54a58af3faa230ab2b8e090697e55342fd37118672fc014ce47",
]

test cs_d52_leaf_insert_a() {
  insert_ok_a(d52_leaf_old, d52_leaf_new, d52_leaf_key, Leaf(#"894bd5fb796842ecc9fa9701be475db9764a282a404ad84904ffc4b1b5d244eb"), d52_leaf_sibs)
}

test cs_d52_leaf_insert_b() {
  insert_ok_b(d52_leaf_old, d52_leaf_new, d52_leaf_key, Leaf(#"894bd5fb796842ecc9fa9701be475db9764a282a404ad84904ffc4b1b5d244eb"), d52_leaf_rev, 52)
}

test cs_d52_leaf_absent_a() {
  absent_ok_a(d52_leaf_old, d52_leaf_key, Leaf(#"894bd5fb796842ecc9fa9701be475db9764a282a404ad84904ffc4b1b5d244eb"), d52_leaf_sibs)
}

test cs_d52_leaf_bogus_new_a() fail {
  insert_ok_a(d52_leaf_old, d52_leaf_bogus, d52_leaf_key, Leaf(#"894bd5fb796842ecc9fa9701be475db9764a282a404ad84904ffc4b1b5d244eb"), d52_leaf_sibs)
}

test cs_d52_leaf_bogus_new_b() fail {
  insert_ok_b(d52_leaf_old, d52_leaf_bogus, d52_leaf_key, Leaf(#"894bd5fb796842ecc9fa9701be475db9764a282a404ad84904ffc4b1b5d244eb"), d52_leaf_rev, 52)
}

const d64_leaf_key: ByteArray = #"6468329619b69b844552720838c397910625110164463d4b1efcd2641f698d4d"
const d64_leaf_old: ByteArray = #"934c61b02098928408a3a8146dabe0619305431833648f0a7d11efdff7908adb"
const d64_leaf_new: ByteArray = #"e237c5f0c114387767c59e158f61d6f3322a59db927e5c33bab3ffc9bfe4b1f9"
const d64_leaf_bogus: ByteArray = #"903c78fe0e6ca7a6ee0b61b9eda4f308ed37ba36522015914cbc107e34a9dee6"

const d64_leaf_sibs: List<ByteArray> = [
  #"18b84c016ffcf4a7f61a7ca25a8a17b2a2349d85bacc8f48480348ef91188014",
  #"37a5430ac4354f385f5f496f0f71bd6d7524ec8781401165c50836619539417b",
  #"43947afa8b37435ce430b19459b13f774ae5106de8e2aa2564c18f18160170ff",
  #"369ef8a606d8a4639ffc1ab6d5bfe00eb04e691861e88165fd9b3f6004baa5f6",
  #"27e317322bc951b4869acb0ff6c829bb95babd95a2459ffe9be191f7fb70a3cf",
  #"4b2a42336d167f825c572945f90784d920f60657608c72b71a740c4da41eeb03",
  #"aac86bb569e24bdf5fe89d30b5145733b4fd1171ad151b9dc1c5842c05f41299",
  #"78478534766635e1dc27abca53bbcb7228d49dd8bd6b8f9c054faf1240aaa6bc",
  #"9800b642e8da94886a3fc92fd57562fd9d0af0b4a659e4ea304f668afd93f1ce",
  #"68f4cd9ec4d96d92cfb823d8bc7d1fbcd940da4c62929b95a938c08c8d96d22b",
  #"77cd73bb541dacbc7e3ec0650dcb319307558c0ce0bacea90ab2c336de849e63",
  #"c5683f968ab5a0aa5eb777cfbeebdd6f92ac82f8ed1bf2c44fb4f2d9ba3cfaa9",
  #"5b4713aa5316357799d2637182e172a23980d723fc12b656845edae37e328740",
  #"580db80e7eb810d4d8adec7db530cec81b9811a62acfd456ff56d33e16ac6ff3",
  #"922217052453b0d1820c72b296f986da0d983a3ea18e6465beeb233bda1eac44",
  #"1e75d4fdcc789863503239f5736bea2d8f4d011c3d45542efa957ddde96668de",
  #"efa3a5b0ef5f1fbac3eb15bace11845cdbfc30a95ff099674e5e0a257e65bbe8",
  #"666e3ce4e96a37412759b975a3fa6395059f9b59615be20471cdab0ca8bf2f0f",
  #"5306f73eeb09fb4a9015fdb5019a36b2d14acdef6d92749f120786b88dd4fadc",
  #"b3a11a3a29f044cdfef1e0a8a216c0e773552b43b47b748507aacab66630ba2f",
  #"68184fcb9b1778913a2a02862b6417e3f7db12603ccdcc35d4ba56587f4432bd",
  #"1fa8e8dac1f80057e8a7ec3d1e474a8f66c4630429db64f4d68b76bcfe06ae2e",
  #"cab20723a4239c61b4d844d20e4b7ccff2b0ddf69c04e3412af95842bcd6d2b1",
  #"cccff2a537ac89c7e90655fba23b198aac88bf3446648718bb2e9f251ab6311e",
  #"d70663871a3303dd5f544bea58992e0a1e4454891b041eaa6d5dd09a2508d9ce",
  #"0b2fb3e26ca018dc77e448ace9ef52e8dc3a9146499721399ae0766bd401e523",
  #"42d760adfe9e0323c1b378b13f1aa9950d7f25e2530d47e9ca9851e9531bd009",
  #"e59739bca096cf2986d66d11b3e92cfcd15ccc8c4aa25f0deae5bf507d0ddb61",
  #"0e278b6295213c8353a8435b44d05e762c1ff2cedf173f16a96e1593ad13013b",
  #"dd7a6aa2a13937848488ae58c082dcc1af1eacb1f855ee754779967a21d8361f",
  #"1c877da9b9f75841ec86077bd666b0d67f170e34b3108a3dd7f4698f822eb5a2",
  #"73c5e888d61afbab85f29106fa9c852a8a9bc8c7528337e23c0f3f1a07203c67",
  #"9f4048e031c471e67f15d6a322c0580ad1fdfce68a093554ac8ebfd2e1fc832c",
  #"d0d3228c7e2bad2fc35bd92cf490b1b7705d940611d87f63806cc8b71b77d1c9",
  #"7c70127126e9ac33f731368782722469dd61da5b42445277b2938bc6cb43fbb7",
  #"57b7f54df9ff6d398fb7995f26f8a23f89e93db0f60bb0aff829abea67722a31",
  #"7edc38170ba2043f5faa54ed0c2a42c3329d5f7a4d50bc638bb0a1652f417213",
  #"3aab8a9e39dac56a0de110b5e02352b50e2a8b69e1c68c3e4a3ac4d3c0de2551",
  #"9b46b9e29cd02fa3507f3bd0121069ee177d76fc04400ad1f7232f183970623a",
  #"22b83ec63838c187a4cd1bc1ab37ee4e671b7cc23b2c5070c6154e7edebc71b7",
  #"1283b2f8eb9f5bb920898c1d45f53c5d60e3180bbc679264481c3e53687fa30d",
  #"e04e37fe8f6a60d7e749cabda82d289dcf090825c5fc8842d03f27813285f1c7",
  #"6a9bac6fd2eb9388058c1d3f323506aebda46f80e7e156911c98588001bf288a",
  #"80b58d50f5d073d12f1ea47b11d54138108511c1c3f8a7625f23f92cadea65a9",
  #"f029a74c69339a6ae81b72ff67d1fcd733af6da8ad47ec8e6e15ae7a060ffa8d",
  #"b90510ade65e55c1bb68385fa1afb3d164db73c50e88e498f3d41fe3743a68ab",
  #"3fa16e3286383df31f69295732c4edd544453fd09f308b5a20f811467285109b",
  #"8ec7ef03f92f7ddd10b5a2569e49646bcc09a2e00660d886c67212bdc69d732f",
  #"5c435f37dcb9ac8501b3a938d1e8b6ac0e270747cd748c587ce24d32647c430f",
  #"9de6c55ca750415045cb8dde49da07887b3bd4fd4525cd035c17b4beede6bf75",
  #"d1ed152bb329483fb7170c9742f8ecd5f4331ab3542fae42e1616d55964bb7a0",
  #"a55c0b8a621a712147482a847e37486820cb1c1115ca19838ba638db8a9342cb",
  #"d60c00f3b03eab1694c86cf1fbb3d39e926aa7b8f3e4d92ed4b7693010485eaf",
  #"957929c6f281c1ab01612fdab1bf7e3ee0c9e8e0621a3a95e16cc0aa8241ac81",
  #"c2908ce5ac4cf92dfa597f456a6f4da453961dc34a7e7be5306645bff6fac07a",
  #"05f50092a59a3bb014f1099816350406bf6e390f32c4da77dc8ca42713f8896b",
  #"a2068f815b6d8ab35ba103f18d57d03087d266bbb0679660d17a086c44c9182c",
  #"db2960adb89cb8a55d831cca767b0318026367d3ab70941bd1ee0a1e852f5f3d",
  #"d0a3d7ab0912082712d6714f14bcbb248ed7203ee5d1757b2513e6d30700e8ae",
  #"597a68026434c605f5b74233b648ff5294f119c62747d2888ec71fa399bf9f91",
  #"fcd77192c23522c5281c12ae72fdfc5368a70f0771fc5e0d6bd321d2d5abbdba",
  #"43671879d1dbe87435896ce19940ffefcf2e04aeae6b8642f15fe7f323110b94",
  #"c5d8930a3396cf7f7bd374d527f41ad512d3af18064b56269ca8f7dec5dbf395",
  #"def868509ca7c26235f3d20ab97b00e3b0ab71bf9c37134f526917a089a28da4",
]
const d64_leaf_rev: List<ByteArray> = [
  #"def868509ca7c26235f3d20ab97b00e3b0ab71bf9c37134f526917a089a28da4",
  #"c5d8930a3396cf7f7bd374d527f41ad512d3af18064b56269ca8f7dec5dbf395",
  #"43671879d1dbe87435896ce19940ffefcf2e04aeae6b8642f15fe7f323110b94",
  #"fcd77192c23522c5281c12ae72fdfc5368a70f0771fc5e0d6bd321d2d5abbdba",
  #"597a68026434c605f5b74233b648ff5294f119c62747d2888ec71fa399bf9f91",
  #"d0a3d7ab0912082712d6714f14bcbb248ed7203ee5d1757b2513e6d30700e8ae",
  #"db2960adb89cb8a55d831cca767b0318026367d3ab70941bd1ee0a1e852f5f3d",
  #"a2068f815b6d8ab35ba103f18d57d03087d266bbb0679660d17a086c44c9182c",
  #"05f50092a59a3bb014f1099816350406bf6e390f32c4da77dc8ca42713f8896b",
  #"c2908ce5ac4cf92dfa597f456a6f4da453961dc34a7e7be5306645bff6fac07a",
  #"957929c6f281c1ab01612fdab1bf7e3ee0c9e8e0621a3a95e16cc0aa8241ac81",
  #"d60c00f3b03eab1694c86cf1fbb3d39e926aa7b8f3e4d92ed4b7693010485eaf",
  #"a55c0b8a621a712147482a847e37486820cb1c1115ca19838ba638db8a9342cb",
  #"d1ed152bb329483fb7170c9742f8ecd5f4331ab3542fae42e1616d55964bb7a0",
  #"9de6c55ca750415045cb8dde49da07887b3bd4fd4525cd035c17b4beede6bf75",
  #"5c435f37dcb9ac8501b3a938d1e8b6ac0e270747cd748c587ce24d32647c430f",
  #"8ec7ef03f92f7ddd10b5a2569e49646bcc09a2e00660d886c67212bdc69d732f",
  #"3fa16e3286383df31f69295732c4edd544453fd09f308b5a20f811467285109b",
  #"b90510ade65e55c1bb68385fa1afb3d164db73c50e88e498f3d41fe3743a68ab",
  #"f029a74c69339a6ae81b72ff67d1fcd733af6da8ad47ec8e6e15ae7a060ffa8d",
  #"80b58d50f5d073d12f1ea47b11d54138108511c1c3f8a7625f23f92cadea65a9",
  #"6a9bac6fd2eb9388058c1d3f323506aebda46f80e7e156911c98588001bf288a",
  #"e04e37fe8f6a60d7e749cabda82d289dcf090825c5fc8842d03f27813285f1c7",
  #"1283b2f8eb9f5bb920898c1d45f53c5d60e3180bbc679264481c3e53687fa30d",
  #"22b83ec63838c187a4cd1bc1ab37ee4e671b7cc23b2c5070c6154e7edebc71b7",
  #"9b46b9e29cd02fa3507f3bd0121069ee177d76fc04400ad1f7232f183970623a",
  #"3aab8a9e39dac56a0de110b5e02352b50e2a8b69e1c68c3e4a3ac4d3c0de2551",
  #"7edc38170ba2043f5faa54ed0c2a42c3329d5f7a4d50bc638bb0a1652f417213",
  #"57b7f54df9ff6d398fb7995f26f8a23f89e93db0f60bb0aff829abea67722a31",
  #"7c70127126e9ac33f731368782722469dd61da5b42445277b2938bc6cb43fbb7",
  #"d0d3228c7e2bad2fc35bd92cf490b1b7705d940611d87f63806cc8b71b77d1c9",
  #"9f4048e031c471e67f15d6a322c0580ad1fdfce68a093554ac8ebfd2e1fc832c",
  #"73c5e888d61afbab85f29106fa9c852a8a9bc8c7528337e23c0f3f1a07203c67",
  #"1c877da9b9f75841ec86077bd666b0d67f170e34b3108a3dd7f4698f822eb5a2",
  #"dd7a6aa2a13937848488ae58c082dcc1af1eacb1f855ee754779967a21d8361f",
  #"0e278b6295213c8353a8435b44d05e762c1ff2cedf173f16a96e1593ad13013b",
  #"e59739bca096cf2986d66d11b3e92cfcd15ccc8c4aa25f0deae5bf507d0ddb61",
  #"42d760adfe9e0323c1b378b13f1aa9950d7f25e2530d47e9ca9851e9531bd009",
  #"0b2fb3e26ca018dc77e448ace9ef52e8dc3a9146499721399ae0766bd401e523",
  #"d70663871a3303dd5f544bea58992e0a1e4454891b041eaa6d5dd09a2508d9ce",
  #"cccff2a537ac89c7e90655fba23b198aac88bf3446648718bb2e9f251ab6311e",
  #"cab20723a4239c61b4d844d20e4b7ccff2b0ddf69c04e3412af95842bcd6d2b1",
  #"1fa8e8dac1f80057e8a7ec3d1e474a8f66c4630429db64f4d68b76bcfe06ae2e",
  #"68184fcb9b1778913a2a02862b6417e3f7db12603ccdcc35d4ba56587f4432bd",
  #"b3a11a3a29f044cdfef1e0a8a216c0e773552b43b47b748507aacab66630ba2f",
  #"5306f73eeb09fb4a9015fdb5019a36b2d14acdef6d92749f120786b88dd4fadc",
  #"666e3ce4e96a37412759b975a3fa6395059f9b59615be20471cdab0ca8bf2f0f",
  #"efa3a5b0ef5f1fbac3eb15bace11845cdbfc30a95ff099674e5e0a257e65bbe8",
  #"1e75d4fdcc789863503239f5736bea2d8f4d011c3d45542efa957ddde96668de",
  #"922217052453b0d1820c72b296f986da0d983a3ea18e6465beeb233bda1eac44",
  #"580db80e7eb810d4d8adec7db530cec81b9811a62acfd456ff56d33e16ac6ff3",
  #"5b4713aa5316357799d2637182e172a23980d723fc12b656845edae37e328740",
  #"c5683f968ab5a0aa5eb777cfbeebdd6f92ac82f8ed1bf2c44fb4f2d9ba3cfaa9",
  #"77cd73bb541dacbc7e3ec0650dcb319307558c0ce0bacea90ab2c336de849e63",
  #"68f4cd9ec4d96d92cfb823d8bc7d1fbcd940da4c62929b95a938c08c8d96d22b",
  #"9800b642e8da94886a3fc92fd57562fd9d0af0b4a659e4ea304f668afd93f1ce",
  #"78478534766635e1dc27abca53bbcb7228d49dd8bd6b8f9c054faf1240aaa6bc",
  #"aac86bb569e24bdf5fe89d30b5145733b4fd1171ad151b9dc1c5842c05f41299",
  #"4b2a42336d167f825c572945f90784d920f60657608c72b71a740c4da41eeb03",
  #"27e317322bc951b4869acb0ff6c829bb95babd95a2459ffe9be191f7fb70a3cf",
  #"369ef8a606d8a4639ffc1ab6d5bfe00eb04e691861e88165fd9b3f6004baa5f6",
  #"43947afa8b37435ce430b19459b13f774ae5106de8e2aa2564c18f18160170ff",
  #"37a5430ac4354f385f5f496f0f71bd6d7524ec8781401165c50836619539417b",
  #"18b84c016ffcf4a7f61a7ca25a8a17b2a2349d85bacc8f48480348ef91188014",
]

test cs_d64_leaf_insert_a() {
  insert_ok_a(d64_leaf_old, d64_leaf_new, d64_leaf_key, Leaf(#"6468329619b69b84907873e574fe9a8776671707cdc50703f6b346ba20c98b2c"), d64_leaf_sibs)
}

test cs_d64_leaf_insert_b() {
  insert_ok_b(d64_leaf_old, d64_leaf_new, d64_leaf_key, Leaf(#"6468329619b69b84907873e574fe9a8776671707cdc50703f6b346ba20c98b2c"), d64_leaf_rev, 64)
}

test cs_d64_leaf_absent_a() {
  absent_ok_a(d64_leaf_old, d64_leaf_key, Leaf(#"6468329619b69b84907873e574fe9a8776671707cdc50703f6b346ba20c98b2c"), d64_leaf_sibs)
}

test cs_d64_leaf_bogus_new_a() fail {
  insert_ok_a(d64_leaf_old, d64_leaf_bogus, d64_leaf_key, Leaf(#"6468329619b69b84907873e574fe9a8776671707cdc50703f6b346ba20c98b2c"), d64_leaf_sibs)
}

test cs_d64_leaf_bogus_new_b() fail {
  insert_ok_b(d64_leaf_old, d64_leaf_bogus, d64_leaf_key, Leaf(#"6468329619b69b84907873e574fe9a8776671707cdc50703f6b346ba20c98b2c"), d64_leaf_rev, 64)
}

const d128_leaf_key: ByteArray = #"3265237118e75b4801321e900faac1e9c04e424b35822d18528f86bdfb9b71e5"
const d128_leaf_old: ByteArray = #"a59885833c9c2a763974d57cf343f37af0c9ad8461f2a12d76f708ebb48ea7a3"
const d128_leaf_new: ByteArray = #"a8cb521d4eb28cc92f96353c64d564da42a8237b3bbc586c5d0e43bfb8aa35ac"
const d128_leaf_bogus: ByteArray = #"711fa886baef78ea8646b454caa77bb1548cdb2ecbe3058c178a157854658fc7"

const d128_leaf_sibs: List<ByteArray> = [
  #"98c2cdca405e7b4dd1c312298ce23f95eddb691dea5cbb77f32b6d63da996b0a",
  #"99b0c492dd1dcd2353e07468042b9701e23bd29c83a21349e3cf84804e9ba75a",
  #"8c0ed655e3f265b2427e253e9ed0f71cd6d8ee813c75a9e8c263178e4862d396",
  #"8ca6749cb9bf21f97d4edc854d4816e00f0621d15551000d2e66bea962e075df",
  #"f25fbcaa00a5ea972eacf7dc9175f46007f536ca3524371f4410e333f56b1e24",
  #"4ed5a8d4aaff2377d9ab6e9007f082cbb4795d262796b0ebeb010134f5d7b4b4",
  #"ea65868eafd845c71ffa3c0fc55017ae8aa503544d35c6f803ced380c969cf30",
  #"8fb1193cd4d5f8d02deed0b1fc351d883240031eaa961f63c8441cb4f774e5ac",
  #"63850a221ff95cdbd340d07caa084d8524d3df53fe76bab359c5c187789d2bb6",
  #"d10e1c14256cd08f89c486a854e2e997271837f5034bfa2222f74595160657e1",
  #"9b8d4c356e161ded6bc3aa3dbfb8644d1f967f9a937d96534e45e0dfe62a8745",
  #"1039978f36e8c8d712237f976bc3a8600681be23355b6157c256eb8b191dd2ac",
  #"cf3fbc69dc0a25c98d8ab4eb75599c516f62390a209e1ce890c84adb5996d7cc",
  #"76ddda975c01eba0289e009a0de8070671764812ca0e3cb93cb80cd94de61949",
  #"d69edd3b8433206c38897c13e40533484f0e6d4b0d621efd5f8a8d3c51e9abc6",
  #"e50c3a935925708c8f08fc9b04eac9e734330ad46b9b43df9486412f0b797055",
  #"879708ad38e8888ab73cd4b67ac9d92b3edc4f34071d6051876879d492ec6d98",
  #"e0c01c60d2ab669136d02373ed9b017dcd607fd218e261a5391ffa7f5e4be1c7",
  #"f3fc16d7ecdd593138181e4bac1e62e3ce83d018f31994497c5f065ac166fc37",
  #"aa2cc9195cf4a23837735c75c522334ff2db970e78f6f848853fe84895f4b708",
  #"643c7958814c6a65e8f798a02819149853cdec07f65444a6e5f6a1b538815024",
  #"5cbda3b3d1330044f47ee7c3b8a964929c6ba826cbb8dd26787e37f3da252bae",
  #"ca28017b3e32ae66981a5a503126f26250d28edb2c17bad105429798e374db4b",
  #"bfbc6958783977ac83dd19914ac107d999b341413f0371cde8d5e2689540bd4a",
  #"ace8050837bcad38e0ab8a06249d04fdac54fb54aa08c667e3068ac0f4497048",
  #"8f552268c27cb7d8e2936300176766f3b86750e83c97c2ee3305eca3386f9a50",
  #"68065915725a0c541716ff189ef500c3988397186fe27c36313ff10bdf0f74d2",
  #"00ec6ac99c837e3d654b32ac397975ea4dc3b7438bf7a547b2749dc48a547fb2",
  #"9025c2a0c854394910bf6cbb11dbb46b2abd5c544a8b5d7ed22f1eb9d7a8ded2",
  #"241b07b74f578b57146039dd6ca523a86fdd2e62edb3a88bf8239a70d8abb2e0",
  #"f15ed435ebe662d323ab0a9f766df1e5cedfc77d8fbc8c9aa9b829bccc4a68ac",
  #"8416e8f6ceba65b1e0a93d178ca613a52df567a1c1b71d0e1fd518f53d1a9f1c",
  #"728334d7c21e2b28e17fd09fadae17cd47f2132e3b524851ac2a966d276a0ff7",
  #"0ed994c2f44a110088339f3aa32b14a41b61480af9b51dc07e01ba7318fd89da",
  #"7bf32b753572c4dc6a14bb5edee11c2095c2e21679cff95d92992421e3e012dd",
  #"a15efaae50440d8a756d8f5689ec5ee4065bfb9cef34927e90b147e23c24514c",
  #"ab0c4daf170befead3ee9a16e9f442d704a837a627451200389d104df55cd13f",
  #"20ec9401fe2c8007870a49c3c3d7ac068fb0a547bcf21f6e1a568a014542f577",
  #"b1b7ffcf04d46bfcd7f46b716659d79be7cefedaad7bb7ab9835d3a380bfc391",
  #"0b7a1d5d0a86a7ac01ac5b07ef95b0615f521a6526e1d86b09426e3e88cfdc5e",
  #"f613f7637f09c4cb511e3fd8bc15f1133b911716df716e438d585120e85935d5",
  #"5005647e5337dacbef2f7890699c0addcc6913e6f22dc1801665543550c9caba",
  #"1e1c5c8a32234da6eceb294ea91b5c2137324c37b7e892372bf068b882e3fda1",
  #"9ec31acf2923a7e4d3dbaf800b258dfb8fe0e86986be729840d8d08854f1df93",
  #"fc2a32a186be26b1d5beea611041f9d5b511f0867bec0441814eb6383eaf3e4a",
  #"55b01f4d8e032ffe2c9129c0b977770267db16c38aa3577b346546d56abd694c",
  #"4d11a48c1938b33ace7a31a8b0e185083fc2b24f059b4dd44471adbefc0fa909",
  #"28bc65938fc7bf61b4e300c1158145016180ec73ff35070c773b7d9fe79ae9f5",
  #"42107d561261825ec22ccffb8461dc76eef24783d34b889136688b8fa2191a8a",
  #"62d76b36dac744a77e6d1ffb5aa1f71b308a400f05edd5f41bd5e3170ed2137b",
  #"a762951e00bf1b662d5968112d5381e50c2d5289034350aa7bf5197a01896c30",
  #"219fe64e909425f4ed17b789ed7321a6b6422989843a76c10b72af5c7db68b0c",
  #"afce174cd951f15a6b50bb30835608e84188fce9721e96651fe6db0f07e719f4",
  #"5682cf02a23061115ba535867af6a01b0252833437b06e4df1606339203b7691",
  #"bf0c48113901e008590da0dba3cdf878bb96a4067795f3e46aa266caa01b1214",
  #"1e56f3f70da2700c12aec8428ed2466c2b854a16115665aec7aacc0f9e6f317b",
  #"d3482fce4b1c44ec9f1e3997481811165bd82f6e9313a9f1a550640ab5984276",
  #"ba1e6f60055c1c5ac52a9bbcf80101012150a480b81f4a5b92222f26db7a6780",
  #"556d6d9cc5cfc55b5a39f6313c83d28900affc67f5263a6b3d08db936b92c0a6",
  #"adeb93426132c04699e7da85e2b7742118dcbf4b3208ea0b764816a59ff2e7de",
  #"566b9956581b1b38288b2db5a181a7fcce19e1a69c4dfd59df0510ce3d1abab9",
  #"b13a9c0f9315cfa9e8f5d5eb41f43440f3715766a776996ddf6802797f30af9b",
  #"b82fb11cd280651d18ef830f43934ad319941e0a83ad1075a7184523135c7f19",
  #"898ca5a3909034726928c45642102e38e255d6bc1299e4e00f54603686098ed5",
  #"5e232a1c753c5d1e2ab6ea8a23aea57d525395be28d40f5667a28c8d4d186e6a",
  #"af52e69f8e0189271e090fe1633a65c3b1c1dd6e7355a35f8093f0764deb0fd3",
  #"7b993b62ed0847fb2dd5c9bbf363bf07e5eb063e606ef2c24f858dcb5372034b",
  #"dd4f0bf0cecdc2d81c74dcfe572ea81675328b2811d1ee66eaa00e8e8c0e9b33",
  #"ab634fc1a4e83d9be24fdd7f2f591020787ce053cc36daa5ec42b8dadfde71e3",
  #"f878d3d3e7946ea32676b9e5c440d83f03f97819960645698efa7399d3e5f8d1",
  #"52d09770fecbd7fbd7b2c19a7f2388ef47b2e926fda75cf5441828c96519d156",
  #"90a7c41649c459888f5ae962b3c918838c86c02f08aa478a4d614c4e3a00cf02",
  #"808bcbc1b33d765ac17a635eb8624438ba17802c74b07e9d381c7964c48902e5",
  #"03cb6470a2d7fd8726986347724e56d2ab0398c1ea2171be5838608588625dfc",
  #"4bc124fa0d07bbd64c66e688fcba5c892c02d7e1079ea1e1ae699940598d164b",
  #"480cd2543aff8b2911f615f522befbbfc6f20919ee34ae9e14317df5dd2f70b3",
  #"6a0637abe3b9571f04696c27f271ef146b013948c3e457c513fced59b9621495",
  #"117dae0f9643ecf102f3280d9e5dcd5bec971bf4c80e6f6ca867c12c247146a0",
  #"903fbf32b81262da7c695c5ac4877605d37d5febb8504924a8c116d9a492872a",
  #"114360f30ea55089655d3dd6c36ee733a1516dc68e38bf29d4132e0f5922644c",
  #"a8cc32d774b5c5e16af1b7c960ad73177e4865e1d61ce610cc94cc9a6a7d557a",
  #"ef82026577ab6fe685f68212e9fb9912a5e37339aca068c8f29cd87cd6cf4f29",
  #"c0cc474df505715dcc8cb86460d4042ae20958c93a53717ace0f8c1312d0c9b8",
  #"9c679a895c761c12d75902ffd6e1956b22167d9351ea357c358c1a33c05a5673",
  #"9bffb0ac498a54aeb4603fa48c6661c18c44a0edcb1c20a095dc923c32dcbe56",
  #"a91d95e83a11a859926128cef6111d357cad2066519a71bf372e87925e8ebcd6",
  #"1bf771f365453c6107aae7e19c15c9f6b30e19af9e3f9197db8e8c78f7e28d91",
  #"685bec539b4112c8913775188e27c85aa39c971a1332148471eb9ab951b8091b",
  #"03d07e90691c69ec381591a43f923e52caaf981b9682b8c046a0105e414412c5",
  #"299d8531507c91358204c4b4fcd65e99c5964c5c029b2bddebe4c4cbb4c22e15",
  #"6c2bbb2bd304f0c9be9fa8f9c1a7959db20e8d9eaeabdca329c61ffd2e27e6e2",
  #"dd68a654b74957b677e3f7b303706e827fb083b5684b3d31121f5d3b05870876",
  #"dc86c74a417395d7f607b876184b3c456bb997a78e2481be90aeb9e8d67ed2fb",
  #"c0f12608a3bf7cd6de8fcf6506662e77c8e3e6c41ea4840b1bc80d509e64cd93",
  #"fc24a99e651a45243263eaf18e06b51ad5a63fd3a309c3633c90935c2d4bcc3e",
  #"3b728bafe543dbbe27a28a26223377ac8c7748e716a35fb1ce5fa4d65fc7680d",
  #"364e060b237cf1ca17e238ec9b647b2442ac88099fedf6451a2db910ce34ada1",
  #"e1aea31073530420f5deef55f8867f4c2904fc3bbf3fa2afc17f98cb207f0227",
  #"0790939ee8eb74a5418be9b05761f4d8b95a21f68fcb9d986b5f832ba0d63a77",
  #"debe7085f07dc7139bd34e934b89c55fcbb28d119ec9c79ed3871ca3b901005d",
  #"902228bfd197055ac8001d799fcdd023154f6b9427d5b809aaff2415e7e3bf8d",
  #"ec02d49611707137f5ecf64921a05b8feb7b1db5dd730bf2add75c2395261ef0",
  #"7ad80a283c86503f78ce71bba433bd20ad798cdd556003bce213d12fbbbba2ca",
  #"b6c09e3c2af77cef460bd17772b046ee6c6ceeeca867467d6729f6574dfa7f5e",
  #"144ba60e517c1d954d3f8d2dc7a7f913bb43f08c568fbf800d0b97cb56717a66",
  #"7db72ad1ef3eeb26edba0fd73b0762b50fb44e815614530ed60be232241e5f3d",
  #"587f05f41cb8a06741800e476480317d320bd695bc27767707fcbbb26bec75a5",
  #"31c235cef51ad64814d9aa2b28a46955ca6e6a56a6058f1c64a2b4871332ae6b",
  #"8067e2428b82b6675a4e5b0354c09b0715183f116e58e3619fd022f52d1056e0",
  #"cc3e86f7a24a291c08c04e50d41e06db4f40006441bc20386ac087814f98a48c",
  #"4de35a7bed7da888e67e5e36399703c7e837d5f870e5dbe077f9b5809dfdd7bd",
  #"0bc857733ee510657323258373c311895924d0f287006131495b9fa436c54eb2",
  #"e360d18d40a36118c49cd1bc7bff688481865cffac66e9cc0976390bef041091",
  #"7cba5aa4147f3a9547e354960daf76eab9623302d83e2675440fa25446901df9",
  #"745dbf64f7086d2a0391b998797fead06af862e97e00df7526f3214beb5cf0fb",
  #"1eac89c0f1d1a8f09a86ebcc75d35757fcdafbc4fb062c01890d83a8afaa1ed9",
  #"ae87de92fe17bc9f1f7f14ea9da2b7fa5bff2282d6d8f3cdf6e0de0be5a59af8",
  #"ed3211f8f72a7a78c88917be67ec8ef3eeafec09d1868ae14d67c00d6498faa6",
  #"0f0e252ddc94835806cc41182a30fa8c36ad49fd19d9230615faab43903f952e",
  #"811b0f18579605dae43a9960ddcb37387c7edae5c00a88531941c36b78bd8ffd",
  #"bbf231e2541dadf14edddbcea535cd498fa42fc406883d115ec9ddae4bc8a6d3",
  #"546ecff41a16600d9fbb263982b8c5adbb0f0ce033ce90e276008e3377055cbe",
  #"2ffdde0d2d46ae57ac36ff00a23bc102ebbd2e2534978f519cd9bb7906115458",
  #"02ab4f14323be6947959f1e8ba6ccaa07311180c9dbaa8015cc46d5d6a561b60",
  #"f334a3b65d3a4b7600693662dc710b043ab2b8b8458a8ac2ba9bd055975d3c8e",
  #"fa7ca35fadf0ab60e270b1a2683094945d3a654a6c81fce764fe11a1af187842",
  #"e1ea98f087c1e3a7df9bbdaa0965d559605211f83171831a88f5e58cc7710d4b",
  #"1460c23cb9bcb832d3ae9fabee525593517d06d40cddf03efc728eea4e4d9f27",
]
const d128_leaf_rev: List<ByteArray> = [
  #"1460c23cb9bcb832d3ae9fabee525593517d06d40cddf03efc728eea4e4d9f27",
  #"e1ea98f087c1e3a7df9bbdaa0965d559605211f83171831a88f5e58cc7710d4b",
  #"fa7ca35fadf0ab60e270b1a2683094945d3a654a6c81fce764fe11a1af187842",
  #"f334a3b65d3a4b7600693662dc710b043ab2b8b8458a8ac2ba9bd055975d3c8e",
  #"02ab4f14323be6947959f1e8ba6ccaa07311180c9dbaa8015cc46d5d6a561b60",
  #"2ffdde0d2d46ae57ac36ff00a23bc102ebbd2e2534978f519cd9bb7906115458",
  #"546ecff41a16600d9fbb263982b8c5adbb0f0ce033ce90e276008e3377055cbe",
  #"bbf231e2541dadf14edddbcea535cd498fa42fc406883d115ec9ddae4bc8a6d3",
  #"811b0f18579605dae43a9960ddcb37387c7edae5c00a88531941c36b78bd8ffd",
  #"0f0e252ddc94835806cc41182a30fa8c36ad49fd19d9230615faab43903f952e",
  #"ed3211f8f72a7a78c88917be67ec8ef3eeafec09d1868ae14d67c00d6498faa6",
  #"ae87de92fe17bc9f1f7f14ea9da2b7fa5bff2282d6d8f3cdf6e0de0be5a59af8",
  #"1eac89c0f1d1a8f09a86ebcc75d35757fcdafbc4fb062c01890d83a8afaa1ed9",
  #"745dbf64f7086d2a0391b998797fead06af862e97e00df7526f3214beb5cf0fb",
  #"7cba5aa4147f3a9547e354960daf76eab9623302d83e2675440fa25446901df9",
  #"e360d18d40a36118c49cd1bc7bff688481865cffac66e9cc0976390bef041091",
  #"0bc857733ee510657323258373c311895924d0f287006131495b9fa436c54eb2",
  #"4de35a7bed7da888e67e5e36399703c7e837d5f870e5dbe077f9b5809dfdd7bd",
  #"cc3e86f7a24a291c08c04e50d41e06db4f40006441bc20386ac087814f98a48c",
  #"8067e2428b82b6675a4e5b0354c09b0715183f116e58e3619fd022f52d1056e0",
  #"31c235cef51ad64814d9aa2b28a46955ca6e6a56a6058f1c64a2b4871332ae6b",
  #"587f05f41cb8a06741800e476480317d320bd695bc27767707fcbbb26bec75a5",
  #"7db72ad1ef3eeb26edba0fd73b0762b50fb44e815614530ed60be232241e5f3d",
  #"144ba60e517c1d954d3f8d2dc7a7f913bb43f08c568fbf800d0b97cb56717a66",
  #"b6c09e3c2af77cef460bd17772b046ee6c6ceeeca867467d6729f6574dfa7f5e",
  #"7ad80a283c86503f78ce71bba433bd20ad798cdd556003bce213d12fbbbba2ca",
  #"ec02d49611707137f5ecf64921a05b8feb7b1db5dd730bf2add75c2395261ef0",
  #"902228bfd197055ac8001d799fcdd023154f6b9427d5b809aaff2415e7e3bf8d",
  #"debe7085f07dc7139bd34e934b89c55fcbb28d119ec9c79ed3871ca3b901005d",
  #"0790939ee8eb74a5418be9b05761f4d8b95a21f68fcb9d986b5f832ba0d63a77",
  #"e1aea31073530420f5deef55f8867f4c2904fc3bbf3fa2afc17f98cb207f0227",
  #"364e060b237cf1ca17e238ec9b647b2442ac88099fedf6451a2db910ce34ada1",
  #"3b728bafe543dbbe27a28a26223377ac8c7748e716a35fb1ce5fa4d65fc7680d",
  #"fc24a99e651a45243263eaf18e06b51ad5a63fd3a309c3633c90935c2d4bcc3e",
  #"c0f12608a3bf7cd6de8fcf6506662e77c8e3e6c41ea4840b1bc80d509e64cd93",
  #"dc86c74a417395d7f607b876184b3c456bb997a78e2481be90aeb9e8d67ed2fb",
  #"dd68a654b74957b677e3f7b303706e827fb083b5684b3d31121f5d3b05870876",
  #"6c2bbb2bd304f0c9be9fa8f9c1a7959db20e8d9eaeabdca329c61ffd2e27e6e2",
  #"299d8531507c91358204c4b4fcd65e99c5964c5c029b2bddebe4c4cbb4c22e15",
  #"03d07e90691c69ec381591a43f923e52caaf981b9682b8c046a0105e414412c5",
  #"685bec539b4112c8913775188e27c85aa39c971a1332148471eb9ab951b8091b",
  #"1bf771f365453c6107aae7e19c15c9f6b30e19af9e3f9197db8e8c78f7e28d91",
  #"a91d95e83a11a859926128cef6111d357cad2066519a71bf372e87925e8ebcd6",
  #"9bffb0ac498a54aeb4603fa48c6661c18c44a0edcb1c20a095dc923c32dcbe56",
  #"9c679a895c761c12d75902ffd6e1956b22167d9351ea357c358c1a33c05a5673",
  #"c0cc474df505715dcc8cb86460d4042ae20958c93a53717ace0f8c1312d0c9b8",
  #"ef82026577ab6fe685f68212e9fb9912a5e37339aca068c8f29cd87cd6cf4f29",
  #"a8cc32d774b5c5e16af1b7c960ad73177e4865e1d61ce610cc94cc9a6a7d557a",
  #"114360f30ea55089655d3dd6c36ee733a1516dc68e38bf29d4132e0f5922644c",
  #"903fbf32b81262da7c695c5ac4877605d37d5febb8504924a8c116d9a492872a",
  #"117dae0f9643ecf102f3280d9e5dcd5bec971bf4c80e6f6ca867c12c247146a0",
  #"6a0637abe3b9571f04696c27f271ef146b013948c3e457c513fced59b9621495",
  #"480cd2543aff8b2911f615f522befbbfc6f20919ee34ae9e14317df5dd2f70b3",
  #"4bc124fa0d07bbd64c66e688fcba5c892c02d7e1079ea1e1ae699940598d164b",
  #"03cb6470a2d7fd8726986347724e56d2ab0398c1ea2171be5838608588625dfc",
  #"808bcbc1b33d765ac17a635eb8624438ba17802c74b07e9d381c7964c48902e5",
  #"90a7c41649c459888f5ae962b3c918838c86c02f08aa478a4d614c4e3a00cf02",
  #"52d09770fecbd7fbd7b2c19a7f2388ef47b2e926fda75cf5441828c96519d156",
  #"f878d3d3e7946ea32676b9e5c440d83f03f97819960645698efa7399d3e5f8d1",
  #"ab634fc1a4e83d9be24fdd7f2f591020787ce053cc36daa5ec42b8dadfde71e3",
  #"dd4f0bf0cecdc2d81c74dcfe572ea81675328b2811d1ee66eaa00e8e8c0e9b33",
  #"7b993b62ed0847fb2dd5c9bbf363bf07e5eb063e606ef2c24f858dcb5372034b",
  #"af52e69f8e0189271e090fe1633a65c3b1c1dd6e7355a35f8093f0764deb0fd3",
  #"5e232a1c753c5d1e2ab6ea8a23aea57d525395be28d40f5667a28c8d4d186e6a",
  #"898ca5a3909034726928c45642102e38e255d6bc1299e4e00f54603686098ed5",
  #"b82fb11cd280651d18ef830f43934ad319941e0a83ad1075a7184523135c7f19",
  #"b13a9c0f9315cfa9e8f5d5eb41f43440f3715766a776996ddf6802797f30af9b",
  #"566b9956581b1b38288b2db5a181a7fcce19e1a69c4dfd59df0510ce3d1abab9",
  #"adeb93426132c04699e7da85e2b7742118dcbf4b3208ea0b764816a59ff2e7de",
  #"556d6d9cc5cfc55b5a39f6313c83d28900affc67f5263a6b3d08db936b92c0a6",
  #"ba1e6f60055c1c5ac52a9bbcf80101012150a480b81f4a5b92222f26db7a6780",
  #"d3482fce4b1c44ec9f1e3997481811165bd82f6e9313a9f1a550640ab5984276",
  #"1e56f3f70da2700c12aec8428ed2466c2b854a16115665aec7aacc0f9e6f317b",
  #"bf0c48113901e008590da0dba3cdf878bb96a4067795f3e46aa266caa01b1214",
  #"5682cf02a23061115ba535867af6a01b0252833437b06e4df1606339203b7691",
  #"afce174cd951f15a6b50bb30835608e84188fce9721e96651fe6db0f07e719f4",
  #"219fe64e909425f4ed17b789ed7321a6b6422989843a76c10b72af5c7db68b0c",
  #"a762951e00bf1b662d5968112d5381e50c2d5289034350aa7bf5197a01896c30",
  #"62d76b36dac744a77e6d1ffb5aa1f71b308a400f05edd5f41bd5e3170ed2137b",
  #"42107d561261825ec22ccffb8461dc76eef24783d34b889136688b8fa2191a8a",
  #"28bc65938fc7bf61b4e300c1158145016180ec73ff35070c773b7d9fe79ae9f5",
  #"4d11a48c1938b33ace7a31a8b0e185083fc2b24f059b4dd44471adbefc0fa909",
  #"55b01f4d8e032ffe2c9129c0b977770267db16c38aa3577b346546d56abd694c",
  #"fc2a32a186be26b1d5beea611041f9d5b511f0867bec0441814eb6383eaf3e4a",
  #"9ec31acf2923a7e4d3dbaf800b258dfb8fe0e86986be729840d8d08854f1df93",
  #"1e1c5c8a32234da6eceb294ea91b5c2137324c37b7e892372bf068b882e3fda1",
  #"5005647e5337dacbef2f7890699c0addcc6913e6f22dc1801665543550c9caba",
  #"f613f7637f09c4cb511e3fd8bc15f1133b911716df716e438d585120e85935d5",
  #"0b7a1d5d0a86a7ac01ac5b07ef95b0615f521a6526e1d86b09426e3e88cfdc5e",
  #"b1b7ffcf04d46bfcd7f46b716659d79be7cefedaad7bb7ab9835d3a380bfc391",
  #"20ec9401fe2c8007870a49c3c3d7ac068fb0a547bcf21f6e1a568a014542f577",
  #"ab0c4daf170befead3ee9a16e9f442d704a837a627451200389d104df55cd13f",
  #"a15efaae50440d8a756d8f5689ec5ee4065bfb9cef34927e90b147e23c24514c",
  #"7bf32b753572c4dc6a14bb5edee11c2095c2e21679cff95d92992421e3e012dd",
  #"0ed994c2f44a110088339f3aa32b14a41b61480af9b51dc07e01ba7318fd89da",
  #"728334d7c21e2b28e17fd09fadae17cd47f2132e3b524851ac2a966d276a0ff7",
  #"8416e8f6ceba65b1e0a93d178ca613a52df567a1c1b71d0e1fd518f53d1a9f1c",
  #"f15ed435ebe662d323ab0a9f766df1e5cedfc77d8fbc8c9aa9b829bccc4a68ac",
  #"241b07b74f578b57146039dd6ca523a86fdd2e62edb3a88bf8239a70d8abb2e0",
  #"9025c2a0c854394910bf6cbb11dbb46b2abd5c544a8b5d7ed22f1eb9d7a8ded2",
  #"00ec6ac99c837e3d654b32ac397975ea4dc3b7438bf7a547b2749dc48a547fb2",
  #"68065915725a0c541716ff189ef500c3988397186fe27c36313ff10bdf0f74d2",
  #"8f552268c27cb7d8e2936300176766f3b86750e83c97c2ee3305eca3386f9a50",
  #"ace8050837bcad38e0ab8a06249d04fdac54fb54aa08c667e3068ac0f4497048",
  #"bfbc6958783977ac83dd19914ac107d999b341413f0371cde8d5e2689540bd4a",
  #"ca28017b3e32ae66981a5a503126f26250d28edb2c17bad105429798e374db4b",
  #"5cbda3b3d1330044f47ee7c3b8a964929c6ba826cbb8dd26787e37f3da252bae",
  #"643c7958814c6a65e8f798a02819149853cdec07f65444a6e5f6a1b538815024",
  #"aa2cc9195cf4a23837735c75c522334ff2db970e78f6f848853fe84895f4b708",
  #"f3fc16d7ecdd593138181e4bac1e62e3ce83d018f31994497c5f065ac166fc37",
  #"e0c01c60d2ab669136d02373ed9b017dcd607fd218e261a5391ffa7f5e4be1c7",
  #"879708ad38e8888ab73cd4b67ac9d92b3edc4f34071d6051876879d492ec6d98",
  #"e50c3a935925708c8f08fc9b04eac9e734330ad46b9b43df9486412f0b797055",
  #"d69edd3b8433206c38897c13e40533484f0e6d4b0d621efd5f8a8d3c51e9abc6",
  #"76ddda975c01eba0289e009a0de8070671764812ca0e3cb93cb80cd94de61949",
  #"cf3fbc69dc0a25c98d8ab4eb75599c516f62390a209e1ce890c84adb5996d7cc",
  #"1039978f36e8c8d712237f976bc3a8600681be23355b6157c256eb8b191dd2ac",
  #"9b8d4c356e161ded6bc3aa3dbfb8644d1f967f9a937d96534e45e0dfe62a8745",
  #"d10e1c14256cd08f89c486a854e2e997271837f5034bfa2222f74595160657e1",
  #"63850a221ff95cdbd340d07caa084d8524d3df53fe76bab359c5c187789d2bb6",
  #"8fb1193cd4d5f8d02deed0b1fc351d883240031eaa961f63c8441cb4f774e5ac",
  #"ea65868eafd845c71ffa3c0fc55017ae8aa503544d35c6f803ced380c969cf30",
  #"4ed5a8d4aaff2377d9ab6e9007f082cbb4795d262796b0ebeb010134f5d7b4b4",
  #"f25fbcaa00a5ea972eacf7dc9175f46007f536ca3524371f4410e333f56b1e24",
  #"8ca6749cb9bf21f97d4edc854d4816e00f0621d15551000d2e66bea962e075df",
  #"8c0ed655e3f265b2427e253e9ed0f71cd6d8ee813c75a9e8c263178e4862d396",
  #"99b0c492dd1dcd2353e07468042b9701e23bd29c83a21349e3cf84804e9ba75a",
  #"98c2cdca405e7b4dd1c312298ce23f95eddb691dea5cbb77f32b6d63da996b0a",
]

test cs_d128_leaf_insert_a() {
  insert_ok_a(d128_leaf_old, d128_leaf_new, d128_leaf_key, Leaf(#"3265237118e75b4801321e900faac1e91afdb2990346326887347e3815bfb07c"), d128_leaf_sibs)
}

test cs_d128_leaf_insert_b() {
  insert_ok_b(d128_leaf_old, d128_leaf_new, d128_leaf_key, Leaf(#"3265237118e75b4801321e900faac1e91afdb2990346326887347e3815bfb07c"), d128_leaf_rev, 128)
}

test cs_d128_leaf_absent_a() {
  absent_ok_a(d128_leaf_old, d128_leaf_key, Leaf(#"3265237118e75b4801321e900faac1e91afdb2990346326887347e3815bfb07c"), d128_leaf_sibs)
}

test cs_d128_leaf_bogus_new_a() fail {
  insert_ok_a(d128_leaf_old, d128_leaf_bogus, d128_leaf_key, Leaf(#"3265237118e75b4801321e900faac1e91afdb2990346326887347e3815bfb07c"), d128_leaf_sibs)
}

test cs_d128_leaf_bogus_new_b() fail {
  insert_ok_b(d128_leaf_old, d128_leaf_bogus, d128_leaf_key, Leaf(#"3265237118e75b4801321e900faac1e91afdb2990346326887347e3815bfb07c"), d128_leaf_rev, 128)
}

const d255_leaf_key: ByteArray = #"de8c7cc258e01cb0e979c7866a1f0a7824a9e9f5c7864b531fc30301a6a91ec5"
const d255_leaf_old: ByteArray = #"374e007b4353fdfc9a6b4bfd702720b29e908c7bc9c930138bacdac87f46027f"
const d255_leaf_new: ByteArray = #"25ffae20e804cf3d5b26de315670ee40de85deb50fe5deb0b0c514b24992bf6a"
const d255_leaf_bogus: ByteArray = #"05758bd5976c1ee2f6e1bd603502584b982a07b400b13907e112b80d041ddf02"

const d255_leaf_sibs: List<ByteArray> = [
  #"64afc281e908763be28f83ab639558e03d40372bd3718be3104ce7d1195c7ef5",
  #"3ff423758d2a2d3997dd6067e90107d4e4e84d219dec22b16c113b900398334e",
  #"6ed5f275a75a2f1625f103cc4406c4e4bc0e798f5e26455dac8c764147b483c0",
  #"ac87dabee247fb66db7f4ad5128dc67290199bda9cbe8b2dc9e87510bb4e7410",
  #"da59a4dd19dc05a5194e001bbdc6cd4f20ab65489bc295106274a8df98a66030",
  #"1b0aae44a51b443d6ff6e88b6b6be16fcc0615b80aa24ed4195ff7472e795cd0",
  #"d4a8420cc11a84e5ddc7aa8516919956951943d9e1959be9c608485761361d74",
  #"59f893d00603ff272c4e49adac3775bfddb7506a174f1f54bfe656ac353cfba1",
  #"d3e1fa2b63cd543a774cb9a5105af27c9215c2b9c26b3c7dfe4d82bfa657b8f6",
  #"d7204518d44e20e67ec30ac0176a8d34987c7183b2c9e5c51170207e76054651",
  #"4599419fe64677b154b615d2089ffc9162e44e9d71e4661b804f1b9b1e01de73",
  #"5e12d2f4a1f0379925d62da19201a1e6ddacd1730ba7ff520990d83f6e97cad9",
  #"02bc619bb4ada96129c3c6e1b341a757608371bc90e35f042ca3d9fc8c5f7fa4",
  #"2fa2d13b35de6d8b5e3681c86b7c12a70da6a4eca959c6cdb5d004eca27d354a",
  #"eb7bec2066c9d212ee55e85b376560ed0638dc210cb63bf4f0bec811ccd4dda4",
  #"35ee6695e3dbeecf22a3227e85b1534f16685443559ec6bba3d6b7dcd6859776",
  #"0d42901392d4d0f52bc8b70b093159154d1dcf20661b3a1d5b6361e0a685f1db",
  #"eae6d0772232c51382cb592323f3105c21c7b1302aff5624c6b021a1e6386e3e",
  #"dea8a1c4f72de12a71bc88c7d97338de1071e2b52720b8f580f65a59728a706c",
  #"47c0aee16a6e28f0bb9f5c184da28f598f73bdbeebc99af86ffb75c74c85a8c5",
  #"f425b652412822a4fec30f2bd112ce7360ca14898c014c8eb923ec910f82f6c1",
  #"7a2bcbcdbb63760e9da090146e772127a2b9a20e7b1a67e66308c6e8dd6e484a",
  #"24109155a9222b4b4ef16aaf23924f3eb50ffd12e94eed266bcdc39fbed357a5",
  #"7b7db25f8084f344ce9a54c27eaf028a9c441b7e58bf083514b154786b95c526",
  #"b105ead7a5503dbea9affac856cfba6c8511850a8e2c163ac1a9e2e259db6fae",
  #"5cb348e3e86072747d28681d4d69df103e1b313edfffbbc211b331c3e0fe4701",
  #"4171d966e7d6605df8d0ff977e8a2376c5190ce055c573b298b394bf4ee30c74",
  #"9c257c4b1f04fe3f93b4e6f36e4105ca86bcb14fbfcb6f1115f5199f7f4e68ef",
  #"96d993c3c05fa962bf3931d6edeb40195c1b6f4687dc1eeb6b47b31373ce3098",
  #"1379b9e3f39161789cda0fc6ae5585bd2f20e920d4a102df151943f6a4688eb1",
  #"7b848156cc4a52e766572de5aa1669d0d530a882732dbde5b7b84d53a1a941f6",
  #"e3b345b67d24c37bb691007d2b30961b6991c294d999bbe8c761b32966276507",
  #"91440b3ed7fa5e82b4723d78c36dbb23151b3ba64c75a4aa88738886030f4b8a",
  #"89ace7c7b76028e58cd809ce6ec5cd434a971bcdd0ed20b1da02975608d29e55",
  #"7e08a85596020014bd076c76cb7a800dc837549da8c55b2b44d7209be1e26692",
  #"5d4d22ee6225ebc0ef29b851d0121d31268b5021ce7ee6ef7ef13b7f8fe7f1c7",
  #"a9e78369f6edb7f530544178a8ebe782c335c6660e13df845bb9810043288cbf",
  #"74efbb2192dd42094bba26d2d392a47f3cbe51b69124021b38bf7a840a9b91a6",
  #"d0be16755694dc0d3496d3355058907691ef5029f36a6e7189e86d4f85331c20",
  #"4922a6f754153ebb9dfb79570ac664650617fa87239f7d6ce76d295567499f61",
  #"9e6670506ae9979fecfc61d1792b87c6c4817bd6cdf2a78778ffdd27715adedd",
  #"fb9aceaddbcc47271b2fb159c3e06af3a131b4ec2b05246507d8dfc054429246",
  #"d40d05a73ad9100fd7037ec6a9ef538147d46670bd924e03e46f1b2e82a664f6",
  #"5eed908e4d4dcde3b12090337376f00869975548ce4341b83367356a78c83d1d",
  #"9fb5bff42d9fc5dab29ddc4315c44f45007546f1d6cc0beec912535fca5e4461",
  #"83b04e2580ece8d7ff8e38d2a52cc163f8b82096edc7b1708b22420b7021651a",
  #"d8ac383425bb8e3535796d1d1bdc964199caa4b29e6734757e15344a85104a06",
  #"c671422ce26872201430aa66b2d74c50470d660c9f97e16ba59373c74c8d2098",
  #"007977f0371e567facde88eaa8c5833b2fe9cbcf4fb81a1c693b1d02f62c49b7",
  #"f4a9bd63b22586d4fb69a6d7cf7a6fab6a2131403366882f3e2a947f9d5ea8cf",
  #"1d154207de941fea6976b16613a20d860c3fc6400bd1cb9ff65f94455014b6d9",
  #"b59cb2ed3177a41143d04dbf3c7eaaa713be66596fe09ca0025ef7f60e55dbfa",
  #"dafda3edf7d05cf1cd186fc96de3fb0745b76ef7069e56cc900fcd4c94339922",
  #"66316235cc5e79a796ae7e83d375e420ef529b4dea4771f857bc7905cf94563c",
  #"0b0162d1afc30800de40ea738d20c4db592d97eaa32074b604e17a77c59aa5d8",
  #"d6a37f039845b203b1789487556ad1f00e7478d707f590686c5c0b26c76f87e8",
  #"432f1681a0f7dc9c6fb2e69ba55797ac74f576e9425638c4630ecf6ea6343ca4",
  #"e983bc701031c4a84979d43deffaa0ab540445a07e1d9060485b1d17a120f8a1",
  #"5df49e2a0b91876c683e102a9ef231eff298ea2358b890ad0c617ce4013621eb",
  #"d584c75158842d67b9f7cd671465b813d00d321491679767c56364ae86127439",
  #"5952d1fae1f65d2a87d1674994227fb318d0de6e7ffd42ef0a9bf11b59674423",
  #"24751fccebdae8681d6c86356047b3de392e6801bb89e467e5fcde51557694d4",
  #"af0b0d262669b961bbca928f748db059b634206e33a8814dfeac2b0e730289db",
  #"28b1c90c85525dd87fa7ef466dcb511941eef242a836e8cbf365e7cb111ce7bc",
  #"69e15e83a320fbd78be0d0aed93c2aa4234f4a72e035e4dfb4abe60129c7fb1e",
  #"5c7b99cdf500778826aa6ed1b24e1c1b90789f74c59363b252dae40ec9a66493",
  #"9285a51e95762da14a7406e7b5c5e801dbee7f2943e97da84cab8b42a27fb467",
  #"f207430dd7b3c2825d7b5ba95b30442b8632a5ea101c546a35bcdb52a500475c",
  #"4fd38887b8280336e7fe766313d321f0d25ec260eda4ae0ca33bd354a62a631d",
  #"2f152322d5a1f752e2ebe67b02355d76fbe1dd401b1b8e1caa8d2390c85d672d",
  #"789026e31c812bffabca653bd24708b6609bc33855993ffa30b0f843f5aecb14",
  #"b9fe3f4c6d9eca062ad829afcb9d4a5f119c0dcdca58279b36233ca03b6aa5f5",
  #"815be27c7186e5f86b76576925951bec80fe185c0bc053144c0328ab2a0ec87f",
  #"1bbdf41b984037779bf0d1278b076a1d19cc03568cef3ad71e159f38c89827e2",
  #"6ced0ff75223a73a6ccf2fb4b9d628861e77b4e9726a6a5837c2536a2b8b032d",
  #"d8db66ec80ba9eb1e04c2dd2a7fcbf063b10449ce1b7ddd96e04d2c31e3b92a6",
  #"3de349d256b3c0928efba2d0fa5ce22e7468b305f6a336d6d62fb47e5cfa081b",
  #"0777d0c3c5a7de166c9e4cb59887061bbe15c5745117f6bef894aeaf330e7ff7",
  #"c891299d7587bd824f9e2c362a9a7f5e964d5cacaf235f75852ffc61a8a5b80f",
  #"fd8abb2aa7334dbb6442925d3ca8de9c9817a847c50890d52334efcad9f069e0",
  #"34f38f229661c87c07cc3140563f55df8e0ca76578505aa3dec9dc1728e6edf0",
  #"523abcb59104daf443dfa5c4310177c99b3afefe9d91dc277ab42a4033aaa815",
  #"e9c1cf5a7a57583ce1e6564df85df9349fe490f2cbd889416bab79749bb6d9d6",
  #"bc13e3a71840041a41e6b68d56dec8b0726d291f79035b44aff96ec1eea3554e",
  #"4575fddbf51103ea2564482ba1cb14088eb84dadcddf4503e9474d8833029059",
  #"68d86198ce17a1e15b5f0f9fa75f31cfd04dc2aa8884a2a641528de23bdc84e7",
  #"1e09ff409e5c5206a3968f828655126da4a7205ae22a04aa2514e8f44528b96a",
  #"75e69d6fde51ccb5cfd0728a5f1864df95758d12927b74cc1b13ca4e71f69d92",
  #"5dffd2e26e9a6a1c33e66a3fc175d25379aa6e3dddf1a609b1403a61079d7566",
  #"e1e4c795a88783a66d33c56444bccf28095f0aacca53258252ac6471410c193a",
  #"d8ddf2de1ce08b843bf59b2314c21a2c3674d082343b986361cae4eef2e18631",
  #"97b1eb6102282663f87df9a9ca582fe0569487932498ead8ae3300837fbba821",
  #"86f2d0c7edf89178b4ff8b3c6fc5a48233689bb4c977f95128a71a43d77b4253",
  #"7e5eadb193e52de2062ee62f0b7a417abb44055c29c06b6924a3a16e1a426772",
  #"30565fc5f72dfc835a0f958a6993904c6889ad131954eb465384e36733d3e03e",
  #"258e645e6efa8d8187c34aad2aa938a539d2045e28b7902f4d5de604bca4a277",
  #"7dd77dce7241c6fa74d08915e1e1e395ed63c5e016b51e5b1e1aefc5f1db31f5",
  #"5c9caa2a54df7105b8d045bb804bf89506ac23cf28f58d72bc6ce85e8a758df7",
  #"f1be901dfc3c037212784a8482fb87390da250a02b81e3d840d480bbfd2aa4ce",
  #"12684a8c7d83bcf4980f30cabe4a13bf2e620152061719f09b41b244016fcd4b",
  #"060bf5029cb0999ae10d8bb40ba0de863c85507cab9360384c516a6bec1ca142",
  #"ac57b7d5dab5e3a3223a16428cbdb8e86d08d722b10d5e590711c9f977fa2e2c",
  #"64fae909fb2f25ff0ef4ce89ee254cd70deceb9521f8eabae50edfc44aacdc40",
  #"01e06b2b715b23a3f86bba06b484955fc4076d2bebcfb88c32098a1c84a057f8",
  #"eb56afbcaa86cca5fa67c9596d48a1af980c6bffcfbc5f005509c7412c065511",
  #"3b39e41fe76aa518371b7b1eb003fd78d6fe7d5cb1439c34873d146864536d9a",
  #"65fff2f2b225e0c18239c0c71e3ffd74d8cd8a2404450cdbcae4008292a7b5f2",
  #"06882da772881cbf8dc4966c03f24f59667761906a36859452bfe80f36bea491",
  #"2a883a7590b07aa1034461c6253e1194aef2130c543db4b949d349f664cfeb24",
  #"ace11014d0ab0b74ed304055c95261ae0c9942b230e71984b5463ff860e13594",
  #"dafe416ed3c8dd0d1e9163c3584e3e127ee4a67f73f34a9d50b57adc7050cd6b",
  #"3365b525ddf3999307c6b5fff3ebc70adfb10f9bb5ebbf36460b71d860ce6de8",
  #"c381b98261f61becbb36709e04a1e5eb1ca559d1a98e46b3106f04334d8ae9de",
  #"73fc2ba2f8c72ca7ec61e6a98e243a4a185c97f307b81c6f3993ada20c1d0606",
  #"8447a5189de1bf99eaafc67a4e2b5ae37ccfa99c532eb9e007ce73f9e31b0977",
  #"b5d1f86fb45f290519de9ace2f68a5d19d8d460429a2a45be011e26f5e618b13",
  #"3574aa7de9b681afbe676fff3d2efc7cbf817d3e686ea2ba9d12a63b73ff07f6",
  #"a04b40d18b7673f3355b3e460de286135cba0f38be54f57a937490a95c5a5ade",
  #"255da27689b0447290abec40afc6bcdc146ce136bdd7bb161a942ea86f62a738",
  #"095f5c2efb096365967f02340bac8286ebeb616354ae2807a7f55d57d7ff8fb5",
  #"aacb2dd58bcc200ecc2f9e99d88f14f467654019f0655eff5f2477f60d3195bf",
  #"f493729cf7a2cdd9fe707b502d2c3d5381d6fd76c6da9bb16eeeb802d396c4b4",
  #"949a8191df49e34f0021a647bfc9e5ad3382448699eea192bd76d1106267035d",
  #"c44569c123cec1cb244515db7c6fc5c4f2a85868f5e237bbb492b5302c36da0e",
  #"42cab6f081e90b4da21b01307cb81b8e8e8cb53e5088ff09d4b11b601b81941d",
  #"9ea8c21a2b404548c21e98128eb95ef76ba865714530408d809e5486654c9551",
  #"4f89d662b434d5f09e33696c8379e2e0b518b45cfa8037f617d2bdec44c26585",
  #"4ba34463e63b1afa934811a63789130c8507d9385c529685e335886fe48196e4",
  #"44d8a0404f784e6ca10c48074bac9e21d29b77fea9fda8aeaa7f075cc7920d3d",
  #"34f0ae00023955f025a70e815d2de62ccf280052300d073b4e8fe411df305daa",
  #"268165473250166bdaf39889dd5f164969e16f599c4bc26d1930d1918fdf9d15",
  #"bee29579eeb545a09529531bd8301eea3352e3d67310a346ca7aff16b46e0837",
  #"3adfa56dbb20e426ad612ff10459ce0d28f7b94fa7ed2d0ecbb8e0d09fb264c0",
  #"24cd1b39e4848dc446b83da5375874c87c568f97952d08dc451dc01b297baa06",
  #"9af23813455132641edb84c2990f745b5742edd45ce11b5f2bbb5e2bbae28f60",
  #"24c2eb05073d68685115934b86c583599ee9186059b2fc5888c4dcc5b901e844",
  #"792cbb9fc4464e31c8c7dde3d53bf0cf759897103aab860c81493447a2196925",
  #"c54df306c929dd825952cc34ebc5b64051fbc0ebc8176d0d116cb53fee1c1119",
  #"dd21401145c441a2f29ccfe862e2fdacb4503a9322e05b9f50e82980b099fef2",
  #"af66bd4f7bd22cf6c419a23d5585cc4eb66a94c128410bf59c93991d0a2d00c8",
  #"620273336027576d3f2e041ae71771e7e54fadafc15f5544f42305983d94ce36",
  #"30250446c99dea515ed0f0c8b692c591d3250320cf505a944a365e129d7cfd44",
  #"f1527c3b496d352f1b58ff6a94cba3ebaaea512010b2b61fc1126dc62b81a452",
  #"85a63266d77aecb679178820c01a42bed51530d2a6d5b2306ce0acb167a9ff75",
  #"382f5d0495a904437ea7b192ba949cb2a9d71dad2ef6f128d0eff0257a2b2c3e",
  #"7d603a4383e7cbceec0f4896f5fb49a765a2e7fd1d979924b23610da7dc9d234",
  #"81b7788cb1cf48ee8ee9245c765c2b1c6754553d781062e5affd65c8d5598ca8",
  #"9399f77110af313da5efa64bf6e23bfef9e23d9435eec9832ce91a7b5a53e3b4",
  #"af4e6a2fc3f50cf9951602c1dfa67f4f7ab2743d82463bbb9011ba9d0acd98d5",
  #"b765fc96266274bd6bb4197a89da05e0e2099c0ae2057b23e5e3bb908219a7a7",
  #"361ccb9aac6bccfbff7733cf84afce10e3e42fe6f84f492967803579c4567211",
  #"b634b595c405cd9d20a98d6141156974f55539078c9bc426da69f90a30660ed5",
  #"09e915e956a2d48545d53d8b1cb22a781cc4ac630ff6f2143b9df5adaa3e8123",
  #"22faf98ab41b4fdacaebe619fd3d3f560ed6fe85080b85be9067744d0fc68f15",
  #"782a792c35a2ce4dc0f2a3123cac0e60de90adebccc2f06fbe032967058bb7bb",
  #"8d312b50fecf664a8915c55c0c184598ced3459a924d305f805e15d11b238210",
  #"9f020b0e6efe10f7121926a9ef3329771b2ec8edfc4eca9387ce23a0bf834119",
  #"7b16094f3c125e400b510ffaebf5366986a020991939cd6425c38047ce440f57",
  #"ddf9dfe4177c96e7ac9f9505db705fccd88cc71ad355cb7d7c72918deb733bdd",
  #"ec1a4c7c0a186edadbf030ff7d40f48978d2c96c037eea7d8c28fc041437efeb",
  #"4a119c96595bd9cfd2d61db12eb583c6742eadf8559d269b47f79b17144bc38f",
  #"64c8130545ae8224d41ea6a41674a1b86e3a79fddc4c9a459d812a3dc5bc1d08",
  #"4af09e0848071bd9794ea3e4f0ab0c51ecd2afc0f129ce30b9d37e81ae92eb1b",
  #"e51cb0506f237f2b39715515867f850847f70c6ee9a4b7ba663c92f219d26248",
  #"20f50ffdb13c3b4980188b7fe12d82df4da28b15e36d69dbed82c42d5c15174d",
  #"599c530d1d15e102fdb53f18d8a5e8729c21943512b996ec6cf222b8b508a69f",
  #"9439f7fa6e4a9a146f617d98f5c88088a4308877b9493a2ef408939d27fb552e",
  #"30eb27ba27514c652f5e6c777595e7be62cce9feb379685f2d14a149b63d5e2d",
  #"5bf1bb800ace5c9013cf6495611c7b608b9978560e02729987d2f36f4cd7d3fb",
  #"ba5f2e6792f190f8f618618528d50ad062f378a1598b31e4286bb3d1e1c10811",
  #"bd9d022d4d1549bc16ac795e6545232f1e4e230715953c8221775e15f8ad1519",
  #"faf309e7d7baec0fddd46f8a2f8acb94967f28b16df1c34db38e8b517dff5e51",
  #"9d9f4e02b4fc16bb33091164324c56c5899c166aa5158a4175e8b6fb901fa75f",
  #"111e14b9369ec266e55499a48e97a3f291a9184bef1fac1a2e3fa8c70b6599cb",
  #"d8da08af9597a1e2c6c228d7d2b7aabb1bcc43f609ebd7b08bbea66f10da428a",
  #"5edfe86517d7722ae2be884aa430b52c7cc4b2152f8381093146f71c6c2d6599",
  #"2a5d4d7b43bca59c2feef0c98ad4eb97a95f81adf566c0554e07b5fa95ffcb9c",
  #"c9d894b9f3833aefa219cd3f94250a888b59e550d989bd1a7ee61a4ff8f980ee",
  #"77d15b6f6f411618220d5d42a043c1f06a56b2044cfcf6b55ee80a06197e4409",
  #"efe15289e2584a3c78a6e12b2d966acecc9b0661cabae9d05729cb12da9ebacd",
  #"2031129eb40dbbc2825cbdaada9390329f14e2b5e6d53371d837e4b7e925cf62",
  #"1a1dd76edc63e0811148e85bb9da8fd029869765de01b2e8dee9922a53240b7f",
  #"5e346d4d25bbb05c75286e6e6a0a93dd5ba3e0b44a22c3466d05b830b347ba5c",
  #"6556c922cdb7b6ae4553aae662830709bdda47147aae282b8d3b99df351c3f26",
  #"1504b8909069b36f9283e477ecb015e97084e7bfa96c5eb539950c6ddab7578c",
  #"46784933a1cdeab33f95c58e7320f312b318d3dac8df764d6fbc9bac39971409",
  #"0bb93cc657c15be3dabb1d3c96a881b596fcc727df76ef2e7a4b40ad201d5061",
  #"e24b8defefd78330606c92d50f28f8488df21fca785dc90ae9745863279f0684",
  #"84359835b7b89cc129dd90d46cf70fbb0a1ad4c3ec705e3e48281f255667bf07",
  #"ccfe115d944403c951e752ae225d316a226829e3e6f2d83cfd8efb486f618363",
  #"56f07cca14ee4306c43be056f086c5e7d9b28b6e7e051d5e471b3f9ff0032e5c",
  #"5661367da2aa3ae7c9b376f2848fcea944d87615b0f355fa468fbaa249246f84",
  #"b8c833236c030dbf51aa731eafc8bbd8736eed8e38ebde82ba72895a21238a12",
  #"a0ec9a957850c9deb14d09851f317470219bb4c6acad487d72981fae75628e3b",
  #"a80b6c9dbfa181f797aa0f2243e4ebb19eb5fcff6e9db67153f3d84451bf9912",
  #"231edb6617086ab96f5888df8fd8429e4610eb22978044928d1eb7dddcc30944",
  #"3c23647df50395424fde9f949920eaa043fe7a33f1a3cdcb0c72641216a73393",
  #"e745b4d11b3088c3d70fcff416fcfabc2ffd5b0304346cd34eecdf719dc563b3",
  #"86804bd69af309d64eb70ffbddf9efcd29c5b2bbe9be27b1adf3d329822e820c",
  #"2a65cbef74e2cb69f036f1e6e54d08bffa863ee7288339c83e5b6c10198bffea",
  #"deb766115b92f822720fed92d09c3ceaf30368630d5fde8d37c107333244c775",
  #"21e33c31eb2a0c77427151c8ee52210bcdac785052475293e5c33a5aa43b355d",
  #"752164038f0d4fd580ca42b06fa7b5a9ef843249d943f352c4e80dbd6e86c9a5",
  #"e7ad3e68c6417e97b885512ddecba9387096c79c0341020bfc79f2ececf6050e",
  #"3f08c135dc266f1ffc8a77e2bf1829e24319498507ae077e617b7c7b35bbe28f",
  #"26184dc4ba236f69b336341f121e9e82d002e2e9d521130368ab5cd6cbe01914",
  #"351290b2d7697fcdf795e632623891448fe1b5e12563335dc5f65c9ae5f697a4",
  #"da0881fa34c96cebb9ae2936def40962518c6518ec4afb6d02284642e2af66b2",
  #"c0570ad315ef9d49dfcc9f8e877cce211017f3ed88eb4cbbdf565473b93ae9f2",
  #"02585e0ada1448f1303a17de5130c942dca155d9fb7b8fcaf6bc5ef94390be32",
  #"117f8a43320aeef8cecdb4cf3625675254890a38814b588bf152f03c77339510",
  #"a8bcc411ee4b81fcfc61d2332492f3c3f07b4ae96e096d8ca64737b97d93ee8b",
  #"b880b3c179fa136d7b558e75541f4022a1656575228bdec2fa8d5bac73d0706a",
  #"2f087ffcfa4e683845cdc072a499d692b9636270404de12699db788ada0d7eda",
  #"57fd2645fef2858af96c6102f4994678f793ee6a30730bbe0a0b01eaf9bfaf16",
  #"68b1ce54020174584bdf555062a9ea92fe82c60b8f54f250e69a0a1487520951",
  #"df8ffeccdc5128aef1dac0812924d9e9052bbcf470d16572c8c581bc19f41ad1",
  #"527c46232ac2e850a83f88afa426328fd802c31fa6cf5d835bd9e412403ef844",
  #"5f80736e3fb28e5ca53afab6b270f3079389d18437e8c767f47eeee7caaba552",
  #"ab2e2ed19a90a84357301aed6a4046a486203c20e9766b83bc9c4dc96ac893cb",
  #"b2bc71da233f64426eb00b423e3756ae871a5bc64ea19e73801f2678df774e17",
  #"395f26cd53379ba08cbdb807234101e59b625224df18bccfeb0db0aec7c85627",
  #"835f7ac636fa8ca7a50ef76d2ed8a9cc756d8f2ebde3fe6f77f9d9fd5f8a9dd2",
  #"c4627f96b6ecb319f37a5c0778b68fe946cf582ba75fc5f61b8f838979a50d9d",
  #"17dd00aff29261432ec51cc818dd90012b6cae8fe7bb757e46a35eebbc6158a1",
  #"b0507012dca29bbaacdf0fee2439700e17f1371ddfd01dd04f5d59a79bad633e",
  #"6526e88defd6f3837492e3d38b44154e938e90e3954db8de3a498fcf9a3d4b8c",
  #"853344b834ce4bba281b1fca1d0b9e842430f10e369d7c853e12941661e07fd9",
  #"afe99a1fde12ae59aa9b5fc8afc854637d713487771d8a91dba7213371d3d651",
  #"1809c2f2d78626d8a9073aeda48b7bdde04f5b72eb843eaca9d9fd26c726cb9a",
  #"6573c8e63bb8738dbdaf581642977240f331da71a9fa4e0f68283dbb93a2dea0",
  #"1b5390b9d6de208d4fff8f36cba36d4f88cb14d6524945e7f76fd74a309c2dc4",
  #"0da693e6f2bd1b70e35560089def204a7732a1cf8cfe7b267762fdf7fdffbd53",
  #"ee4048cda8cc2a11d8fe482418ad0a2d0aec37e051521249c6939c1d5435edf5",
  #"5ef54c21f8108cd83a6396e2bc42643b9d7c494a02412eab4141e799392a1df5",
  #"cf67cce9aa14f14c22cec73ea195d711c4a1dd7fefccf85f37f090030d6ec2f2",
  #"f2c9434db83b19252778e8aeec444c3fd269c2e6a63c4bfd1efde28bd3b62743",
  #"e6c1d55ea966a3bb2fe3940522eb48167a6f392c2d6907f261f8d51eb1943a00",
  #"89d818b1b69b50d1ce94b1fa9014164fff0fe20c893ce9ceb877b27866e2a673",
  #"a1b63781722c06dc854b0524f0abe3233b19a2be6ff8174ad048a717d1d43301",
  #"38d1298917637541ba4fb1e1fa7935a6ff868c16d548f802442e8fcf779788bb",
  #"d48640438cc77f5c80c6d6b80c637a4d4a550753240ee6e9c2f14f32d19607d2",
  #"8f01046a6b25751d8e2b2df621958558a0faa8f9a68a034953cdcee2d9eb6b64",
  #"1872c5e1ed7b5de94d89b9dc4373b521d89a55d1ff63682b371a2100d24a2584",
  #"f0c5ba9e7ab6bf0d96e9c1683115eeee9f966fd56424b7b4e9d2bf61f8ab3b4d",
  #"64d6dc8a14991abca9d565b3a0d23eaf5f3cc9c1167cde3d3bcaaa64f273a4d9",
  #"4654c3f80cae2c5945aa10eb7b37ef6ae7496cfcf34e7253d9030bfc01565dd2",
  #"2ff4c83eff4bbab3a0b658c71723a56595aa1a4fcb10c7c04c409a0cfb4530ed",
  #"f40787b15dfafcf0da992e60c46407f252f5b1c7e76ce6f72d7944a11b207edd",
  #"efba434bfe0f77c64b03035bd5d408c44cf9dfc99aa3644e615c5c64ad709654",
  #"c2b60c77cb7f7aa4c044a15fed11d8f79c9fa87d5095376ac179e4aa3e5708f3",
  #"12d54e3c75d070b40cc8b8fe135b8cd0ad427182aa73b3fb73777a2777c9a8c3",
  #"22d2aa2b36912e1b5740e15ec08f6e51b7f9280113fa2f1c1e6cace166e0f443",
  #"18ac9e991317af77884dbf32235a1daa39c3b5ad7cdf723e3b154248a3c63260",
  #"caa7ba0d2fd758b01df8bdaf3db8185cb770bdade79f4ca075b7a3171932c40d",
]
const d255_leaf_rev: List<ByteArray> = [
  #"caa7ba0d2fd758b01df8bdaf3db8185cb770bdade79f4ca075b7a3171932c40d",
  #"18ac9e991317af77884dbf32235a1daa39c3b5ad7cdf723e3b154248a3c63260",
  #"22d2aa2b36912e1b5740e15ec08f6e51b7f9280113fa2f1c1e6cace166e0f443",
  #"12d54e3c75d070b40cc8b8fe135b8cd0ad427182aa73b3fb73777a2777c9a8c3",
  #"c2b60c77cb7f7aa4c044a15fed11d8f79c9fa87d5095376ac179e4aa3e5708f3",
  #"efba434bfe0f77c64b03035bd5d408c44cf9dfc99aa3644e615c5c64ad709654",
  #"f40787b15dfafcf0da992e60c46407f252f5b1c7e76ce6f72d7944a11b207edd",
  #"2ff4c83eff4bbab3a0b658c71723a56595aa1a4fcb10c7c04c409a0cfb4530ed",
  #"4654c3f80cae2c5945aa10eb7b37ef6ae7496cfcf34e7253d9030bfc01565dd2",
  #"64d6dc8a14991abca9d565b3a0d23eaf5f3cc9c1167cde3d3bcaaa64f273a4d9",
  #"f0c5ba9e7ab6bf0d96e9c1683115eeee9f966fd56424b7b4e9d2bf61f8ab3b4d",
  #"1872c5e1ed7b5de94d89b9dc4373b521d89a55d1ff63682b371a2100d24a2584",
  #"8f01046a6b25751d8e2b2df621958558a0faa8f9a68a034953cdcee2d9eb6b64",
  #"d48640438cc77f5c80c6d6b80c637a4d4a550753240ee6e9c2f14f32d19607d2",
  #"38d1298917637541ba4fb1e1fa7935a6ff868c16d548f802442e8fcf779788bb",
  #"a1b63781722c06dc854b0524f0abe3233b19a2be6ff8174ad048a717d1d43301",
  #"89d818b1b69b50d1ce94b1fa9014164fff0fe20c893ce9ceb877b27866e2a673",
  #"e6c1d55ea966a3bb2fe3940522eb48167a6f392c2d6907f261f8d51eb1943a00",
  #"f2c9434db83b19252778e8aeec444c3fd269c2e6a63c4bfd1efde28bd3b62743",
  #"cf67cce9aa14f14c22cec73ea195d711c4a1dd7fefccf85f37f090030d6ec2f2",
  #"5ef54c21f8108cd83a6396e2bc42643b9d7c494a02412eab4141e799392a1df5",
  #"ee4048cda8cc2a11d8fe482418ad0a2d0aec37e051521249c6939c1d5435edf5",
  #"0da693e6f2bd1b70e35560089def204a7732a1cf8cfe7b267762fdf7fdffbd53",
  #"1b5390b9d6de208d4fff8f36cba36d4f88cb14d6524945e7f76fd74a309c2dc4",
  #"6573c8e63bb8738dbdaf581642977240f331da71a9fa4e0f68283dbb93a2dea0",
  #"1809c2f2d78626d8a9073aeda48b7bdde04f5b72eb843eaca9d9fd26c726cb9a",
  #"afe99a1fde12ae59aa9b5fc8afc854637d713487771d8a91dba7213371d3d651",
  #"853344b834ce4bba281b1fca1d0b9e842430f10e369d7c853e12941661e07fd9",
  #"6526e88defd6f3837492e3d38b44154e938e90e3954db8de3a498fcf9a3d4b8c",
  #"b0507012dca29bbaacdf0fee2439700e17f1371ddfd01dd04f5d59a79bad633e",
  #"17dd00aff29261432ec51cc818dd90012b6cae8fe7bb757e46a35eebbc6158a1",
  #"c4627f96b6ecb319f37a5c0778b68fe946cf582ba75fc5f61b8f838979a50d9d",
  #"835f7ac636fa8ca7a50ef76d2ed8a9cc756d8f2ebde3fe6f77f9d9fd5f8a9dd2",
  #"395f26cd53379ba08cbdb807234101e59b625224df18bccfeb0db0aec7c85627",
  #"b2bc71da233f64426eb00b423e3756ae871a5bc64ea19e73801f2678df774e17",
  #"ab2e2ed19a90a84357301aed6a4046a486203c20e9766b83bc9c4dc96ac893cb",
  #"5f80736e3fb28e5ca53afab6b270f3079389d18437e8c767f47eeee7caaba552",
  #"527c46232ac2e850a83f88afa426328fd802c31fa6cf5d835bd9e412403ef844",
  #"df8ffeccdc5128aef1dac0812924d9e9052bbcf470d16572c8c581bc19f41ad1",
  #"68b1ce54020174584bdf555062a9ea92fe82c60b8f54f250e69a0a1487520951",
  #"57fd2645fef2858af96c6102f4994678f793ee6a30730bbe0a0b01eaf9bfaf16",
  #"2f087ffcfa4e683845cdc072a499d692b9636270404de12699db788ada0d7eda",
  #"b880b3c179fa136d7b558e75541f4022a1656575228bdec2fa8d5bac73d0706a",
  #"a8bcc411ee4b81fcfc61d2332492f3c3f07b4ae96e096d8ca64737b97d93ee8b",
  #"117f8a43320aeef8cecdb4cf3625675254890a38814b588bf152f03c77339510",
  #"02585e0ada1448f1303a17de5130c942dca155d9fb7b8fcaf6bc5ef94390be32",
  #"c0570ad315ef9d49dfcc9f8e877cce211017f3ed88eb4cbbdf565473b93ae9f2",
  #"da0881fa34c96cebb9ae2936def40962518c6518ec4afb6d02284642e2af66b2",
  #"351290b2d7697fcdf795e632623891448fe1b5e12563335dc5f65c9ae5f697a4",
  #"26184dc4ba236f69b336341f121e9e82d002e2e9d521130368ab5cd6cbe01914",
  #"3f08c135dc266f1ffc8a77e2bf1829e24319498507ae077e617b7c7b35bbe28f",
  #"e7ad3e68c6417e97b885512ddecba9387096c79c0341020bfc79f2ececf6050e",
  #"752164038f0d4fd580ca42b06fa7b5a9ef843249d943f352c4e80dbd6e86c9a5",
  #"21e33c31eb2a0c77427151c8ee52210bcdac785052475293e5c33a5aa43b355d",
  #"deb766115b92f822720fed92d09c3ceaf30368630d5fde8d37c107333244c775",
  #"2a65cbef74e2cb69f036f1e6e54d08bffa863ee7288339c83e5b6c10198bffea",
  #"86804bd69af309d64eb70ffbddf9efcd29c5b2bbe9be27b1adf3d329822e820c",
  #"e745b4d11b3088c3d70fcff416fcfabc2ffd5b0304346cd34eecdf719dc563b3",
  #"3c23647df50395424fde9f949920eaa043fe7a33f1a3cdcb0c72641216a73393",
  #"231edb6617086ab96f5888df8fd8429e4610eb22978044928d1eb7dddcc30944",
  #"a80b6c9dbfa181f797aa0f2243e4ebb19eb5fcff6e9db67153f3d84451bf9912",
  #"a0ec9a957850c9deb14d09851f317470219bb4c6acad487d72981fae75628e3b",
  #"b8c833236c030dbf51aa731eafc8bbd8736eed8e38ebde82ba72895a21238a12",
  #"5661367da2aa3ae7c9b376f2848fcea944d87615b0f355fa468fbaa249246f84",
  #"56f07cca14ee4306c43be056f086c5e7d9b28b6e7e051d5e471b3f9ff0032e5c",
  #"ccfe115d944403c951e752ae225d316a226829e3e6f2d83cfd8efb486f618363",
  #"84359835b7b89cc129dd90d46cf70fbb0a1ad4c3ec705e3e48281f255667bf07",
  #"e24b8defefd78330606c92d50f28f8488df21fca785dc90ae9745863279f0684",
  #"0bb93cc657c15be3dabb1d3c96a881b596fcc727df76ef2e7a4b40ad201d5061",
  #"46784933a1cdeab33f95c58e7320f312b318d3dac8df764d6fbc9bac39971409",
  #"1504b8909069b36f9283e477ecb015e97084e7bfa96c5eb539950c6ddab7578c",
  #"6556c922cdb7b6ae4553aae662830709bdda47147aae282b8d3b99df351c3f26",
  #"5e346d4d25bbb05c75286e6e6a0a93dd5ba3e0b44a22c3466d05b830b347ba5c",
  #"1a1dd76edc63e0811148e85bb9da8fd029869765de01b2e8dee9922a53240b7f",
  #"2031129eb40dbbc2825cbdaada9390329f14e2b5e6d53371d837e4b7e925cf62",
  #"efe15289e2584a3c78a6e12b2d966acecc9b0661cabae9d05729cb12da9ebacd",
  #"77d15b6f6f411618220d5d42a043c1f06a56b2044cfcf6b55ee80a06197e4409",
  #"c9d894b9f3833aefa219cd3f94250a888b59e550d989bd1a7ee61a4ff8f980ee",
  #"2a5d4d7b43bca59c2feef0c98ad4eb97a95f81adf566c0554e07b5fa95ffcb9c",
  #"5edfe86517d7722ae2be884aa430b52c7cc4b2152f8381093146f71c6c2d6599",
  #"d8da08af9597a1e2c6c228d7d2b7aabb1bcc43f609ebd7b08bbea66f10da428a",
  #"111e14b9369ec266e55499a48e97a3f291a9184bef1fac1a2e3fa8c70b6599cb",
  #"9d9f4e02b4fc16bb33091164324c56c5899c166aa5158a4175e8b6fb901fa75f",
  #"faf309e7d7baec0fddd46f8a2f8acb94967f28b16df1c34db38e8b517dff5e51",
  #"bd9d022d4d1549bc16ac795e6545232f1e4e230715953c8221775e15f8ad1519",
  #"ba5f2e6792f190f8f618618528d50ad062f378a1598b31e4286bb3d1e1c10811",
  #"5bf1bb800ace5c9013cf6495611c7b608b9978560e02729987d2f36f4cd7d3fb",
  #"30eb27ba27514c652f5e6c777595e7be62cce9feb379685f2d14a149b63d5e2d",
  #"9439f7fa6e4a9a146f617d98f5c88088a4308877b9493a2ef408939d27fb552e",
  #"599c530d1d15e102fdb53f18d8a5e8729c21943512b996ec6cf222b8b508a69f",
  #"20f50ffdb13c3b4980188b7fe12d82df4da28b15e36d69dbed82c42d5c15174d",
  #"e51cb0506f237f2b39715515867f850847f70c6ee9a4b7ba663c92f219d26248",
  #"4af09e0848071bd9794ea3e4f0ab0c51ecd2afc0f129ce30b9d37e81ae92eb1b",
  #"64c8130545ae8224d41ea6a41674a1b86e3a79fddc4c9a459d812a3dc5bc1d08",
  #"4a119c96595bd9cfd2d61db12eb583c6742eadf8559d269b47f79b17144bc38f",
  #"ec1a4c7c0a186edadbf030ff7d40f48978d2c96c037eea7d8c28fc041437efeb",
  #"ddf9dfe4177c96e7ac9f9505db705fccd88cc71ad355cb7d7c72918deb733bdd",
  #"7b16094f3c125e400b510ffaebf5366986a020991939cd6425c38047ce440f57",
  #"9f020b0e6efe10f7121926a9ef3329771b2ec8edfc4eca9387ce23a0bf834119",
  #"8d312b50fecf664a8915c55c0c184598ced3459a924d305f805e15d11b238210",
  #"782a792c35a2ce4dc0f2a3123cac0e60de90adebccc2f06fbe032967058bb7bb",
  #"22faf98ab41b4fdacaebe619fd3d3f560ed6fe85080b85be9067744d0fc68f15",
  #"09e915e956a2d48545d53d8b1cb22a781cc4ac630ff6f2143b9df5adaa3e8123",
  #"b634b595c405cd9d20a98d6141156974f55539078c9bc426da69f90a30660ed5",
  #"361ccb9aac6bccfbff7733cf84afce10e3e42fe6f84f492967803579c4567211",
  #"b765fc96266274bd6bb4197a89da05e0e2099c0ae2057b23e5e3bb908219a7a7",
  #"af4e6a2fc3f50cf9951602c1dfa67f4f7ab2743d82463bbb9011ba9d0acd98d5",
  #"9399f77110af313da5efa64bf6e23bfef9e23d9435eec9832ce91a7b5a53e3b4",
  #"81b7788cb1cf48ee8ee9245c765c2b1c6754553d781062e5affd65c8d5598ca8",
  #"7d603a4383e7cbceec0f4896f5fb49a765a2e7fd1d979924b23610da7dc9d234",
  #"382f5d0495a904437ea7b192ba949cb2a9d71dad2ef6f128d0eff0257a2b2c3e",
  #"85a63266d77aecb679178820c01a42bed51530d2a6d5b2306ce0acb167a9ff75",
  #"f1527c3b496d352f1b58ff6a94cba3ebaaea512010b2b61fc1126dc62b81a452",
  #"30250446c99dea515ed0f0c8b692c591d3250320cf505a944a365e129d7cfd44",
  #"620273336027576d3f2e041ae71771e7e54fadafc15f5544f42305983d94ce36",
  #"af66bd4f7bd22cf6c419a23d5585cc4eb66a94c128410bf59c93991d0a2d00c8",
  #"dd21401145c441a2f29ccfe862e2fdacb4503a9322e05b9f50e82980b099fef2",
  #"c54df306c929dd825952cc34ebc5b64051fbc0ebc8176d0d116cb53fee1c1119",
  #"792cbb9fc4464e31c8c7dde3d53bf0cf759897103aab860c81493447a2196925",
  #"24c2eb05073d68685115934b86c583599ee9186059b2fc5888c4dcc5b901e844",
  #"9af23813455132641edb84c2990f745b5742edd45ce11b5f2bbb5e2bbae28f60",
  #"24cd1b39e4848dc446b83da5375874c87c568f97952d08dc451dc01b297baa06",
  #"3adfa56dbb20e426ad612ff10459ce0d28f7b94fa7ed2d0ecbb8e0d09fb264c0",
  #"bee29579eeb545a09529531bd8301eea3352e3d67310a346ca7aff16b46e0837",
  #"268165473250166bdaf39889dd5f164969e16f599c4bc26d1930d1918fdf9d15",
  #"34f0ae00023955f025a70e815d2de62ccf280052300d073b4e8fe411df305daa",
  #"44d8a0404f784e6ca10c48074bac9e21d29b77fea9fda8aeaa7f075cc7920d3d",
  #"4ba34463e63b1afa934811a63789130c8507d9385c529685e335886fe48196e4",
  #"4f89d662b434d5f09e33696c8379e2e0b518b45cfa8037f617d2bdec44c26585",
  #"9ea8c21a2b404548c21e98128eb95ef76ba865714530408d809e5486654c9551",
  #"42cab6f081e90b4da21b01307cb81b8e8e8cb53e5088ff09d4b11b601b81941d",
  #"c44569c123cec1cb244515db7c6fc5c4f2a85868f5e237bbb492b5302c36da0e",
  #"949a8191df49e34f0021a647bfc9e5ad3382448699eea192bd76d1106267035d",
  #"f493729cf7a2cdd9fe707b502d2c3d5381d6fd76c6da9bb16eeeb802d396c4b4",
  #"aacb2dd58bcc200ecc2f9e99d88f14f467654019f0655eff5f2477f60d3195bf",
  #"095f5c2efb096365967f02340bac8286ebeb616354ae2807a7f55d57d7ff8fb5",
  #"255da27689b0447290abec40afc6bcdc146ce136bdd7bb161a942ea86f62a738",
  #"a04b40d18b7673f3355b3e460de286135cba0f38be54f57a937490a95c5a5ade",
  #"3574aa7de9b681afbe676fff3d2efc7cbf817d3e686ea2ba9d12a63b73ff07f6",
  #"b5d1f86fb45f290519de9ace2f68a5d19d8d460429a2a45be011e26f5e618b13",
  #"8447a5189de1bf99eaafc67a4e2b5ae37ccfa99c532eb9e007ce73f9e31b0977",
  #"73fc2ba2f8c72ca7ec61e6a98e243a4a185c97f307b81c6f3993ada20c1d0606",
  #"c381b98261f61becbb36709e04a1e5eb1ca559d1a98e46b3106f04334d8ae9de",
  #"3365b525ddf3999307c6b5fff3ebc70adfb10f9bb5ebbf36460b71d860ce6de8",
  #"dafe416ed3c8dd0d1e9163c3584e3e127ee4a67f73f34a9d50b57adc7050cd6b",
  #"ace11014d0ab0b74ed304055c95261ae0c9942b230e71984b5463ff860e13594",
  #"2a883a7590b07aa1034461c6253e1194aef2130c543db4b949d349f664cfeb24",
  #"06882da772881cbf8dc4966c03f24f59667761906a36859452bfe80f36bea491",
  #"65fff2f2b225e0c18239c0c71e3ffd74d8cd8a2404450cdbcae4008292a7b5f2",
  #"3b39e41fe76aa518371b7b1eb003fd78d6fe7d5cb1439c34873d146864536d9a",
  #"eb56afbcaa86cca5fa67c9596d48a1af980c6bffcfbc5f005509c7412c065511",
  #"01e06b2b715b23a3f86bba06b484955fc4076d2bebcfb88c32098a1c84a057f8",
  #"64fae909fb2f25ff0ef4ce89ee254cd70deceb9521f8eabae50edfc44aacdc40",
  #"ac57b7d5dab5e3a3223a16428cbdb8e86d08d722b10d5e590711c9f977fa2e2c",
  #"060bf5029cb0999ae10d8bb40ba0de863c85507cab9360384c516a6bec1ca142",
  #"12684a8c7d83bcf4980f30cabe4a13bf2e620152061719f09b41b244016fcd4b",
  #"f1be901dfc3c037212784a8482fb87390da250a02b81e3d840d480bbfd2aa4ce",
  #"5c9caa2a54df7105b8d045bb804bf89506ac23cf28f58d72bc6ce85e8a758df7",
  #"7dd77dce7241c6fa74d08915e1e1e395ed63c5e016b51e5b1e1aefc5f1db31f5",
  #"258e645e6efa8d8187c34aad2aa938a539d2045e28b7902f4d5de604bca4a277",
  #"30565fc5f72dfc835a0f958a6993904c6889ad131954eb465384e36733d3e03e",
  #"7e5eadb193e52de2062ee62f0b7a417abb44055c29c06b6924a3a16e1a426772",
  #"86f2d0c7edf89178b4ff8b3c6fc5a48233689bb4c977f95128a71a43d77b4253",
  #"97b1eb6102282663f87df9a9ca582fe0569487932498ead8ae3300837fbba821",
  #"d8ddf2de1ce08b843bf59b2314c21a2c3674d082343b986361cae4eef2e18631",
  #"e1e4c795a88783a66d33c56444bccf28095f0aacca53258252ac6471410c193a",
  #"5dffd2e26e9a6a1c33e66a3fc175d25379aa6e3dddf1a609b1403a61079d7566",
  #"75e69d6fde51ccb5cfd0728a5f1864df95758d12927b74cc1b13ca4e71f69d92",
  #"1e09ff409e5c5206a3968f828655126da4a7205ae22a04aa2514e8f44528b96a",
  #"68d86198ce17a1e15b5f0f9fa75f31cfd04dc2aa8884a2a641528de23bdc84e7",
  #"4575fddbf51103ea2564482ba1cb14088eb84dadcddf4503e9474d8833029059",
  #"bc13e3a71840041a41e6b68d56dec8b0726d291f79035b44aff96ec1eea3554e",
  #"e9c1cf5a7a57583ce1e6564df85df9349fe490f2cbd889416bab79749bb6d9d6",
  #"523abcb59104daf443dfa5c4310177c99b3afefe9d91dc277ab42a4033aaa815",
  #"34f38f229661c87c07cc3140563f55df8e0ca76578505aa3dec9dc1728e6edf0",
  #"fd8abb2aa7334dbb6442925d3ca8de9c9817a847c50890d52334efcad9f069e0",
  #"c891299d7587bd824f9e2c362a9a7f5e964d5cacaf235f75852ffc61a8a5b80f",
  #"0777d0c3c5a7de166c9e4cb59887061bbe15c5745117f6bef894aeaf330e7ff7",
  #"3de349d256b3c0928efba2d0fa5ce22e7468b305f6a336d6d62fb47e5cfa081b",
  #"d8db66ec80ba9eb1e04c2dd2a7fcbf063b10449ce1b7ddd96e04d2c31e3b92a6",
  #"6ced0ff75223a73a6ccf2fb4b9d628861e77b4e9726a6a5837c2536a2b8b032d",
  #"1bbdf41b984037779bf0d1278b076a1d19cc03568cef3ad71e159f38c89827e2",
  #"815be27c7186e5f86b76576925951bec80fe185c0bc053144c0328ab2a0ec87f",
  #"b9fe3f4c6d9eca062ad829afcb9d4a5f119c0dcdca58279b36233ca03b6aa5f5",
  #"789026e31c812bffabca653bd24708b6609bc33855993ffa30b0f843f5aecb14",
  #"2f152322d5a1f752e2ebe67b02355d76fbe1dd401b1b8e1caa8d2390c85d672d",
  #"4fd38887b8280336e7fe766313d321f0d25ec260eda4ae0ca33bd354a62a631d",
  #"f207430dd7b3c2825d7b5ba95b30442b8632a5ea101c546a35bcdb52a500475c",
  #"9285a51e95762da14a7406e7b5c5e801dbee7f2943e97da84cab8b42a27fb467",
  #"5c7b99cdf500778826aa6ed1b24e1c1b90789f74c59363b252dae40ec9a66493",
  #"69e15e83a320fbd78be0d0aed93c2aa4234f4a72e035e4dfb4abe60129c7fb1e",
  #"28b1c90c85525dd87fa7ef466dcb511941eef242a836e8cbf365e7cb111ce7bc",
  #"af0b0d262669b961bbca928f748db059b634206e33a8814dfeac2b0e730289db",
  #"24751fccebdae8681d6c86356047b3de392e6801bb89e467e5fcde51557694d4",
  #"5952d1fae1f65d2a87d1674994227fb318d0de6e7ffd42ef0a9bf11b59674423",
  #"d584c75158842d67b9f7cd671465b813d00d321491679767c56364ae86127439",
  #"5df49e2a0b91876c683e102a9ef231eff298ea2358b890ad0c617ce4013621eb",
  #"e983bc701031c4a84979d43deffaa0ab540445a07e1d9060485b1d17a120f8a1",
  #"432f1681a0f7dc9c6fb2e69ba55797ac74f576e9425638c4630ecf6ea6343ca4",
  #"d6a37f039845b203b1789487556ad1f00e7478d707f590686c5c0b26c76f87e8",
  #"0b0162d1afc30800de40ea738d20c4db592d97eaa32074b604e17a77c59aa5d8",
  #"66316235cc5e79a796ae7e83d375e420ef529b4dea4771f857bc7905cf94563c",
  #"dafda3edf7d05cf1cd186fc96de3fb0745b76ef7069e56cc900fcd4c94339922",
  #"b59cb2ed3177a41143d04dbf3c7eaaa713be66596fe09ca0025ef7f60e55dbfa",
  #"1d154207de941fea6976b16613a20d860c3fc6400bd1cb9ff65f94455014b6d9",
  #"f4a9bd63b22586d4fb69a6d7cf7a6fab6a2131403366882f3e2a947f9d5ea8cf",
  #"007977f0371e567facde88eaa8c5833b2fe9cbcf4fb81a1c693b1d02f62c49b7",
  #"c671422ce26872201430aa66b2d74c50470d660c9f97e16ba59373c74c8d2098",
  #"d8ac383425bb8e3535796d1d1bdc964199caa4b29e6734757e15344a85104a06",
  #"83b04e2580ece8d7ff8e38d2a52cc163f8b82096edc7b1708b22420b7021651a",
  #"9fb5bff42d9fc5dab29ddc4315c44f45007546f1d6cc0beec912535fca5e4461",
  #"5eed908e4d4dcde3b12090337376f00869975548ce4341b83367356a78c83d1d",
  #"d40d05a73ad9100fd7037ec6a9ef538147d46670bd924e03e46f1b2e82a664f6",
  #"fb9aceaddbcc47271b2fb159c3e06af3a131b4ec2b05246507d8dfc054429246",
  #"9e6670506ae9979fecfc61d1792b87c6c4817bd6cdf2a78778ffdd27715adedd",
  #"4922a6f754153ebb9dfb79570ac664650617fa87239f7d6ce76d295567499f61",
  #"d0be16755694dc0d3496d3355058907691ef5029f36a6e7189e86d4f85331c20",
  #"74efbb2192dd42094bba26d2d392a47f3cbe51b69124021b38bf7a840a9b91a6",
  #"a9e78369f6edb7f530544178a8ebe782c335c6660e13df845bb9810043288cbf",
  #"5d4d22ee6225ebc0ef29b851d0121d31268b5021ce7ee6ef7ef13b7f8fe7f1c7",
  #"7e08a85596020014bd076c76cb7a800dc837549da8c55b2b44d7209be1e26692",
  #"89ace7c7b76028e58cd809ce6ec5cd434a971bcdd0ed20b1da02975608d29e55",
  #"91440b3ed7fa5e82b4723d78c36dbb23151b3ba64c75a4aa88738886030f4b8a",
  #"e3b345b67d24c37bb691007d2b30961b6991c294d999bbe8c761b32966276507",
  #"7b848156cc4a52e766572de5aa1669d0d530a882732dbde5b7b84d53a1a941f6",
  #"1379b9e3f39161789cda0fc6ae5585bd2f20e920d4a102df151943f6a4688eb1",
  #"96d993c3c05fa962bf3931d6edeb40195c1b6f4687dc1eeb6b47b31373ce3098",
  #"9c257c4b1f04fe3f93b4e6f36e4105ca86bcb14fbfcb6f1115f5199f7f4e68ef",
  #"4171d966e7d6605df8d0ff977e8a2376c5190ce055c573b298b394bf4ee30c74",
  #"5cb348e3e86072747d28681d4d69df103e1b313edfffbbc211b331c3e0fe4701",
  #"b105ead7a5503dbea9affac856cfba6c8511850a8e2c163ac1a9e2e259db6fae",
  #"7b7db25f8084f344ce9a54c27eaf028a9c441b7e58bf083514b154786b95c526",
  #"24109155a9222b4b4ef16aaf23924f3eb50ffd12e94eed266bcdc39fbed357a5",
  #"7a2bcbcdbb63760e9da090146e772127a2b9a20e7b1a67e66308c6e8dd6e484a",
  #"f425b652412822a4fec30f2bd112ce7360ca14898c014c8eb923ec910f82f6c1",
  #"47c0aee16a6e28f0bb9f5c184da28f598f73bdbeebc99af86ffb75c74c85a8c5",
  #"dea8a1c4f72de12a71bc88c7d97338de1071e2b52720b8f580f65a59728a706c",
  #"eae6d0772232c51382cb592323f3105c21c7b1302aff5624c6b021a1e6386e3e",
  #"0d42901392d4d0f52bc8b70b093159154d1dcf20661b3a1d5b6361e0a685f1db",
  #"35ee6695e3dbeecf22a3227e85b1534f16685443559ec6bba3d6b7dcd6859776",
  #"eb7bec2066c9d212ee55e85b376560ed0638dc210cb63bf4f0bec811ccd4dda4",
  #"2fa2d13b35de6d8b5e3681c86b7c12a70da6a4eca959c6cdb5d004eca27d354a",
  #"02bc619bb4ada96129c3c6e1b341a757608371bc90e35f042ca3d9fc8c5f7fa4",
  #"5e12d2f4a1f0379925d62da19201a1e6ddacd1730ba7ff520990d83f6e97cad9",
  #"4599419fe64677b154b615d2089ffc9162e44e9d71e4661b804f1b9b1e01de73",
  #"d7204518d44e20e67ec30ac0176a8d34987c7183b2c9e5c51170207e76054651",
  #"d3e1fa2b63cd543a774cb9a5105af27c9215c2b9c26b3c7dfe4d82bfa657b8f6",
  #"59f893d00603ff272c4e49adac3775bfddb7506a174f1f54bfe656ac353cfba1",
  #"d4a8420cc11a84e5ddc7aa8516919956951943d9e1959be9c608485761361d74",
  #"1b0aae44a51b443d6ff6e88b6b6be16fcc0615b80aa24ed4195ff7472e795cd0",
  #"da59a4dd19dc05a5194e001bbdc6cd4f20ab65489bc295106274a8df98a66030",
  #"ac87dabee247fb66db7f4ad5128dc67290199bda9cbe8b2dc9e87510bb4e7410",
  #"6ed5f275a75a2f1625f103cc4406c4e4bc0e798f5e26455dac8c764147b483c0",
  #"3ff423758d2a2d3997dd6067e90107d4e4e84d219dec22b16c113b900398334e",
  #"64afc281e908763be28f83ab639558e03d40372bd3718be3104ce7d1195c7ef5",
]

test cs_d255_leaf_insert_a() {
  insert_ok_a(d255_leaf_old, d255_leaf_new, d255_leaf_key, Leaf(#"de8c7cc258e01cb0e979c7866a1f0a7824a9e9f5c7864b531fc30301a6a91ec4"), d255_leaf_sibs)
}

test cs_d255_leaf_insert_b() {
  insert_ok_b(d255_leaf_old, d255_leaf_new, d255_leaf_key, Leaf(#"de8c7cc258e01cb0e979c7866a1f0a7824a9e9f5c7864b531fc30301a6a91ec4"), d255_leaf_rev, 255)
}

test cs_d255_leaf_absent_a() {
  absent_ok_a(d255_leaf_old, d255_leaf_key, Leaf(#"de8c7cc258e01cb0e979c7866a1f0a7824a9e9f5c7864b531fc30301a6a91ec4"), d255_leaf_sibs)
}

test cs_d255_leaf_bogus_new_a() fail {
  insert_ok_a(d255_leaf_old, d255_leaf_bogus, d255_leaf_key, Leaf(#"de8c7cc258e01cb0e979c7866a1f0a7824a9e9f5c7864b531fc30301a6a91ec4"), d255_leaf_sibs)
}

test cs_d255_leaf_bogus_new_b() fail {
  insert_ok_b(d255_leaf_old, d255_leaf_bogus, d255_leaf_key, Leaf(#"de8c7cc258e01cb0e979c7866a1f0a7824a9e9f5c7864b531fc30301a6a91ec4"), d255_leaf_rev, 255)
}

const d27_leaf_x37_key: ByteArray = #"83241b68f037ae7bab4217980f2d8fc0d2d5bba7c876aa2c54cbc893c2afe049"
const d27_leaf_x37_old: ByteArray = #"481c20358dd6144b629721b4cc8ea9ea1026d31f672de2c89f14c2156b6ddf2e"
const d27_leaf_x37_new: ByteArray = #"f5f7fc42134cb4863bbd697fc095bd4d6c9455f4fb72513566570b2055b40f6e"
const d27_leaf_x37_bogus: ByteArray = #"f050a58cfa80973e19990b5a3af2ad41b53ba3ed7a5bbd0a23a3c8d60bc57851"

const d27_leaf_x37_sibs: List<ByteArray> = [
  #"14e0aee2aead12e75129f1a4a4a3dd2f67c6e4e0d18bd68c2f420bb34dac5c91",
  #"fa25b1a29c18c8b699afdbc528c3f4c12c873100b0817497ec87329dc4823557",
  #"dff373d39039d2d9fa022057f9532f27c77cd3c6ea4dc7fecf9f9fb93c13bb88",
  #"3c6957c10910679a468f874e5dcb3252a581d1f5212ebb8b8e162741f12a11df",
  #"db88b8be52030ed9aa488e30433c667fe9c9c8675abbba01ac751d07c789c4be",
  #"9e84514a3e027788fc5b3de0ca48d60751897e70f93aa81d7ede56e97d168381",
  #"4e0af268467c3d539755ceb813fce1a5cd40190937d2c88d695b37d3ca99d410",
  #"54501247cc36e923ab4addb8d791a5fbb488783bc5c8d04e6262cf17192c934f",
  #"3f22c06a0357493b73c1fd5022bd8f0d91f276cdcf2193f2cb674635267c2f6c",
  #"3d62da809c2c2a69635d3a7ce43de044e7743766e44987257106d78ebf81b6ac",
  #"dde4f10015c895d19f1c26957091707cd49875829b8a604a046152d436020072",
  #"43e6481f94e314c12cf6fbcb4b8eba49d58a4e0638ad1bffeb9a2ace316dd8a8",
  #"8b937cb62b6d92d8e1ca5fb277c49437f962ce90e784d9716c6fc4de0b2d1b88",
  #"6a5e35f6336cca967295e97da93e84a235511e88398a23dae44b9cd58a6cf559",
  #"4e8b5f0d9222c7e8c32dc9af96817d86c9fb20af80e7a6d8c25f071178aca399",
  #"c68c13a0cc098cdfec21a41257253b7ec2759d7455a3851dfda4dfd817f88bd8",
  #"f65fe1a49d7be9c79f4b0b2e758884cee461726809bf383ccb24933ffe7edf5e",
  #"a852629484bb81ad6b15ce96410f046bf1dfe0bc69eaff51ad9390f51ebac867",
  #"065a334c2ce27484c2f83577a24b80c16b753de2e0ea4144777d92eddebddd85",
  #"0aa307d5df7bfb8bc8acfe2cec4f1b731f62282393da0da449e8ffbea70c097c",
  #"4b6e9b25a8e75af7a1d268836b1859c4fb04bc8b82af6594219ff0ce559d3f6a",
  #"d7d22420ff8e6b5070bc024cfab5a9cf2f53ae1e7d03321437f01b5050a2088a",
  #"f6c1625f1109354ab85c43a3e8d3ed6e6a1266dd3e40daeea5d2b13b99540e9a",
  #"dfe3c1a66586345364ad38012a04d2d2a510a3939930faad6c2b34689030d765",
  #"b4888789a58df35bb843de1a23fc3e27fc17a57b0c2130b991cd149ba87f8803",
  #"e48932cf8c3a4d606e7dde1a5e6766dcf11ea9e3b0290cca2602148e6bedc12c",
  #"d58fa4e500f397eab6a515cab496666847c66ad18d551b8bd07f51323de97c7a",
]
const d27_leaf_x37_rev: List<ByteArray> = [
  #"d58fa4e500f397eab6a515cab496666847c66ad18d551b8bd07f51323de97c7a",
  #"e48932cf8c3a4d606e7dde1a5e6766dcf11ea9e3b0290cca2602148e6bedc12c",
  #"b4888789a58df35bb843de1a23fc3e27fc17a57b0c2130b991cd149ba87f8803",
  #"dfe3c1a66586345364ad38012a04d2d2a510a3939930faad6c2b34689030d765",
  #"f6c1625f1109354ab85c43a3e8d3ed6e6a1266dd3e40daeea5d2b13b99540e9a",
  #"d7d22420ff8e6b5070bc024cfab5a9cf2f53ae1e7d03321437f01b5050a2088a",
  #"4b6e9b25a8e75af7a1d268836b1859c4fb04bc8b82af6594219ff0ce559d3f6a",
  #"0aa307d5df7bfb8bc8acfe2cec4f1b731f62282393da0da449e8ffbea70c097c",
  #"065a334c2ce27484c2f83577a24b80c16b753de2e0ea4144777d92eddebddd85",
  #"a852629484bb81ad6b15ce96410f046bf1dfe0bc69eaff51ad9390f51ebac867",
  #"f65fe1a49d7be9c79f4b0b2e758884cee461726809bf383ccb24933ffe7edf5e",
  #"c68c13a0cc098cdfec21a41257253b7ec2759d7455a3851dfda4dfd817f88bd8",
  #"4e8b5f0d9222c7e8c32dc9af96817d86c9fb20af80e7a6d8c25f071178aca399",
  #"6a5e35f6336cca967295e97da93e84a235511e88398a23dae44b9cd58a6cf559",
  #"8b937cb62b6d92d8e1ca5fb277c49437f962ce90e784d9716c6fc4de0b2d1b88",
  #"43e6481f94e314c12cf6fbcb4b8eba49d58a4e0638ad1bffeb9a2ace316dd8a8",
  #"dde4f10015c895d19f1c26957091707cd49875829b8a604a046152d436020072",
  #"3d62da809c2c2a69635d3a7ce43de044e7743766e44987257106d78ebf81b6ac",
  #"3f22c06a0357493b73c1fd5022bd8f0d91f276cdcf2193f2cb674635267c2f6c",
  #"54501247cc36e923ab4addb8d791a5fbb488783bc5c8d04e6262cf17192c934f",
  #"4e0af268467c3d539755ceb813fce1a5cd40190937d2c88d695b37d3ca99d410",
  #"9e84514a3e027788fc5b3de0ca48d60751897e70f93aa81d7ede56e97d168381",
  #"db88b8be52030ed9aa488e30433c667fe9c9c8675abbba01ac751d07c789c4be",
  #"3c6957c10910679a468f874e5dcb3252a581d1f5212ebb8b8e162741f12a11df",
  #"dff373d39039d2d9fa022057f9532f27c77cd3c6ea4dc7fecf9f9fb93c13bb88",
  #"fa25b1a29c18c8b699afdbc528c3f4c12c873100b0817497ec87329dc4823557",
  #"14e0aee2aead12e75129f1a4a4a3dd2f67c6e4e0d18bd68c2f420bb34dac5c91",
]

test cs_d27_leaf_x37_insert_a() {
  insert_ok_a(d27_leaf_x37_old, d27_leaf_x37_new, d27_leaf_x37_key, Leaf(#"83241b68f037ae7b45afef076ce9b149eab46352ffcd088c5a161cd13538c219"), d27_leaf_x37_sibs)
}

test cs_d27_leaf_x37_insert_b() {
  insert_ok_b(d27_leaf_x37_old, d27_leaf_x37_new, d27_leaf_x37_key, Leaf(#"83241b68f037ae7b45afef076ce9b149eab46352ffcd088c5a161cd13538c219"), d27_leaf_x37_rev, 27)
}

test cs_d27_leaf_x37_absent_a() {
  absent_ok_a(d27_leaf_x37_old, d27_leaf_x37_key, Leaf(#"83241b68f037ae7b45afef076ce9b149eab46352ffcd088c5a161cd13538c219"), d27_leaf_x37_sibs)
}

test cs_d27_leaf_x37_bogus_new_a() fail {
  insert_ok_a(d27_leaf_x37_old, d27_leaf_x37_bogus, d27_leaf_x37_key, Leaf(#"83241b68f037ae7b45afef076ce9b149eab46352ffcd088c5a161cd13538c219"), d27_leaf_x37_sibs)
}

test cs_d27_leaf_x37_bogus_new_b() fail {
  insert_ok_b(d27_leaf_x37_old, d27_leaf_x37_bogus, d27_leaf_x37_key, Leaf(#"83241b68f037ae7b45afef076ce9b149eab46352ffcd088c5a161cd13538c219"), d27_leaf_x37_rev, 27)
}

const d27_leaf_x228_key: ByteArray = #"0782b3b4b2db68b63d47638b4a4a9691b71ccacdd43c2a4fede19b47420b4a2a"
const d27_leaf_x228_old: ByteArray = #"156e931c5f0b097d1b537c6cd6b7ea2c5d9c5daa4c4ccfec2c8723ed3cb212fe"
const d27_leaf_x228_new: ByteArray = #"12596779e32cab3a3124c315784d94097d91d5d1a2cdccef03d4c5fa77f58df6"
const d27_leaf_x228_bogus: ByteArray = #"14d40200284f384ef0b1fc68ba5ec117599e9f4af3a22127e30ec573b9e6bc28"

const d27_leaf_x228_sibs: List<ByteArray> = [
  #"3f4872bb390986031a317045261f90f5640b5134dbfce149171bf41cce283dbb",
  #"ddbe3d2ff307c5552b478b4c8bb325ade4218223ee326968f1bd7ae675053316",
  #"06c3a99efc879f2f48a9e7158f9da8c188c6941510eb31edfbe40e76fa0772dc",
  #"0377346b1a0aefb6f4b97d377b8e7472c409ed9d81ce67d81a2bf9dda2b63274",
  #"05c9f3e26ce2c042ddd6aacb6dbbfcf9f83f4da98fa06edeb479fb0dd8148bbb",
  #"5578a20f987d5edd93f7e6160a7650f2e543b95cef581af2e0b2d10dc677f814",
  #"627bfd6abe12475e0b559bd496dc3792b14ef140107dd82f93e44ca4aaaa0d6e",
  #"cc3e27ab0875ddc02b49aee4e4af7a1c9a732833e80382f31d6f0ed81ca0a284",
  #"67dd47bd25cdd460997108a374a55879d6b7f86721be2e5e5ea9b4198373acef",
  #"666d6d3f764772b0e4a282d9a3c35c425a579aa4ecaedaf7dc307bca693d2e98",
  #"4731069133bc11566b56020d5d4501e201b07507cafd3af80c63a2385086141b",
  #"3d178ee83388951482619c8318f213bc5ab65eb266ffbafc84e94a44496e4cb6",
  #"71341651010687ba382f0ae5877f61c518e00754e7cfe55892aa4921a18d787d",
  #"180a413078db0388f950a02bd021a77b75d79db4d407b9664a34b683cc3b52a0",
  #"185c12b70dd60cca0ddab7c7e8c58b494aaf33020a655a4c15e5eee50cd29605",
  #"8167cfa679fa9665312d1fdcc02a021c16dca9d248400a3c45cdaf72ce4452ba",
  #"87a44ba5d71a0abd80fdd033ebec4a338af48109f34184fcb71becb22c85700f",
  #"c49b1f982da34aa35d4d36c7474517ec71b899d5b824419cf8ad5bb0b3f33aa1",
  #"9db15d4ca2dea4a7e108ca48edc31158058de6620199928c2a3d0f0b29d60a21",
  #"6b0e3102680043ed08f98818e199a1c7d52d507bed879aff1a0c848b6d12ac5e",
  #"fea8fe185af6d19eeb6a843f4492496f7a199c8f1b61a01c0d6a3a14ec0137e1",
  #"0ad5afc9d40352bbdf750f44f9fa67efa76720cd20fa4fc57849fdcde66562ca",
  #"fce35f79485c671764cbdb461847d45fa9ed39b522f6733b1e572404076e33e5",
  #"e474c6d2351efd34b86c21600a34a8b9710c9bb7fe0395e9dfca3f882ccc25df",
  #"f065fec3f7b37b3659fc02e753eea83f995b4d944a6c4c33f08a1a73f5df3ccd",
  #"be9dcf6a073e66f27229d9142df5c6f95b9a4a6086ad739dcf1fa90860b0042b",
  #"101eb2b9b8e3096c37d476640cb95dd0db91f34ef90b4cb069f47079a88a2829",
]
const d27_leaf_x228_rev: List<ByteArray> = [
  #"101eb2b9b8e3096c37d476640cb95dd0db91f34ef90b4cb069f47079a88a2829",
  #"be9dcf6a073e66f27229d9142df5c6f95b9a4a6086ad739dcf1fa90860b0042b",
  #"f065fec3f7b37b3659fc02e753eea83f995b4d944a6c4c33f08a1a73f5df3ccd",
  #"e474c6d2351efd34b86c21600a34a8b9710c9bb7fe0395e9dfca3f882ccc25df",
  #"fce35f79485c671764cbdb461847d45fa9ed39b522f6733b1e572404076e33e5",
  #"0ad5afc9d40352bbdf750f44f9fa67efa76720cd20fa4fc57849fdcde66562ca",
  #"fea8fe185af6d19eeb6a843f4492496f7a199c8f1b61a01c0d6a3a14ec0137e1",
  #"6b0e3102680043ed08f98818e199a1c7d52d507bed879aff1a0c848b6d12ac5e",
  #"9db15d4ca2dea4a7e108ca48edc31158058de6620199928c2a3d0f0b29d60a21",
  #"c49b1f982da34aa35d4d36c7474517ec71b899d5b824419cf8ad5bb0b3f33aa1",
  #"87a44ba5d71a0abd80fdd033ebec4a338af48109f34184fcb71becb22c85700f",
  #"8167cfa679fa9665312d1fdcc02a021c16dca9d248400a3c45cdaf72ce4452ba",
  #"185c12b70dd60cca0ddab7c7e8c58b494aaf33020a655a4c15e5eee50cd29605",
  #"180a413078db0388f950a02bd021a77b75d79db4d407b9664a34b683cc3b52a0",
  #"71341651010687ba382f0ae5877f61c518e00754e7cfe55892aa4921a18d787d",
  #"3d178ee83388951482619c8318f213bc5ab65eb266ffbafc84e94a44496e4cb6",
  #"4731069133bc11566b56020d5d4501e201b07507cafd3af80c63a2385086141b",
  #"666d6d3f764772b0e4a282d9a3c35c425a579aa4ecaedaf7dc307bca693d2e98",
  #"67dd47bd25cdd460997108a374a55879d6b7f86721be2e5e5ea9b4198373acef",
  #"cc3e27ab0875ddc02b49aee4e4af7a1c9a732833e80382f31d6f0ed81ca0a284",
  #"627bfd6abe12475e0b559bd496dc3792b14ef140107dd82f93e44ca4aaaa0d6e",
  #"5578a20f987d5edd93f7e6160a7650f2e543b95cef581af2e0b2d10dc677f814",
  #"05c9f3e26ce2c042ddd6aacb6dbbfcf9f83f4da98fa06edeb479fb0dd8148bbb",
  #"0377346b1a0aefb6f4b97d377b8e7472c409ed9d81ce67d81a2bf9dda2b63274",
  #"06c3a99efc879f2f48a9e7158f9da8c188c6941510eb31edfbe40e76fa0772dc",
  #"ddbe3d2ff307c5552b478b4c8bb325ade4218223ee326968f1bd7ae675053316",
  #"3f4872bb390986031a317045261f90f5640b5134dbfce149171bf41cce283dbb",
]

test cs_d27_leaf_x228_insert_a() {
  insert_ok_a(d27_leaf_x228_old, d27_leaf_x228_new, d27_leaf_x228_key, Leaf(#"0782b3b4b2db68b63d47638b4a4a9691b71ccacdd43c2a4fede19b47420b4a2b"), d27_leaf_x228_sibs)
}

test cs_d27_leaf_x228_insert_b() {
  insert_ok_b(d27_leaf_x228_old, d27_leaf_x228_new, d27_leaf_x228_key, Leaf(#"0782b3b4b2db68b63d47638b4a4a9691b71ccacdd43c2a4fede19b47420b4a2b"), d27_leaf_x228_rev, 27)
}

test cs_d27_leaf_x228_absent_a() {
  absent_ok_a(d27_leaf_x228_old, d27_leaf_x228_key, Leaf(#"0782b3b4b2db68b63d47638b4a4a9691b71ccacdd43c2a4fede19b47420b4a2b"), d27_leaf_x228_sibs)
}

test cs_d27_leaf_x228_bogus_new_a() fail {
  insert_ok_a(d27_leaf_x228_old, d27_leaf_x228_bogus, d27_leaf_x228_key, Leaf(#"0782b3b4b2db68b63d47638b4a4a9691b71ccacdd43c2a4fede19b47420b4a2b"), d27_leaf_x228_sibs)
}

test cs_d27_leaf_x228_bogus_new_b() fail {
  insert_ok_b(d27_leaf_x228_old, d27_leaf_x228_bogus, d27_leaf_x228_key, Leaf(#"0782b3b4b2db68b63d47638b4a4a9691b71ccacdd43c2a4fede19b47420b4a2b"), d27_leaf_x228_rev, 27)
}

const d20_leaf_x17_key: ByteArray = #"1a1c1a455340f0ac5fbd6ecc268707f9ee44397681ef99808d6f295e93543e45"
const d20_leaf_x17_old: ByteArray = #"b128574465e40e677ad07cb25e94d31a3813a02ddaca995f8be67746d35bb101"
const d20_leaf_x17_new: ByteArray = #"15d4d2a7543e2804020e1b0fb6a5d0b5aeefcd53ed376371a0ff9f10111befc4"
const d20_leaf_x17_bogus: ByteArray = #"00b410c6197633202ebab340af15ad208e8714c4eb4c76c78c6febb0b862455d"

const d20_leaf_x17_sibs: List<ByteArray> = [
  #"91f881bc3bcbd580946b461fb5d7e9af760326820f85def066defec872fbe426",
  #"1dddd34459c494ce0cbbb7ecd4871cc0c758dbee06a40e9a57069e32efdd35b3",
  #"9875b3e62e23440994face849e2e776576b07f0da3497fcaf10353fac37eb56e",
  #"04c733e68aeb11245f4eaccc03cebe44835b5622877ed6c50c783c0489876126",
  #"d816ce7354f93e04703cf8412bcd8fe800044e424d9ef665d327259e682dd163",
  #"b4b4c80150a0737d684d9a959aca1fbd4f745b8deb9323feb619c24c1f4cac4b",
  #"ae61c20a73b96ebbccd99d6194469aa4bafc92152eb2065c6f86dbf60235943a",
  #"418e5310128b55f85e8f0fa6c11a236ca08a8d74f3544b731a75e68d2d3915f8",
  #"149235a8da7692f56e03feb4df787f0dfc577f341998662e84461fe7d5e7d2be",
  #"d1596816e15aaa672d6bddb22eeca7ebeda94d83bd0d18fe0dbc9753f60ef733",
  #"2d3aa9cab7f6e4ae88884460088894ef74ab6afab4daa23ff922e490da7de86f",
  #"3fdccfa66e0386a4f365b6089aee113d7ccc9591eb1edf02405142f9812f4c9d",
  #"89ed6bcdd536d5d9703b61ae0336e2d0be77273beaef92b0f96d310a3ec26df2",
  #"e0e49239fbc4a677b00ab42859a54ad473aab67ec5bbb520d649ae1e7709ebd4",
  #"7ba15a98acebe8db1e061e7b3ef6cd31159e1e7962977d72104b81459765c319",
  #"9e4369b68ab5cf04016dc3717810e28a9900567009d8b7f51d086605ce900531",
  #"73bc6f27dacbfa4af1fe9067ed0b34f2fef5aeed2bd361d14a88a9b737f8b9b8",
  #"c24a44e5a2e2825f7835f083c6af134fac5ec4bd18f5c32273509958e68bffda",
  #"8fd7e1694f632101f3b7db4e10679e7f55ac4c85da405005be78aa71dee3ff6c",
  #"3a346bd15cda2bfa742975655b41477f080a7e5712d1752b39eb3c91d9080b8e",
]
const d20_leaf_x17_rev: List<ByteArray> = [
  #"3a346bd15cda2bfa742975655b41477f080a7e5712d1752b39eb3c91d9080b8e",
  #"8fd7e1694f632101f3b7db4e10679e7f55ac4c85da405005be78aa71dee3ff6c",
  #"c24a44e5a2e2825f7835f083c6af134fac5ec4bd18f5c32273509958e68bffda",
  #"73bc6f27dacbfa4af1fe9067ed0b34f2fef5aeed2bd361d14a88a9b737f8b9b8",
  #"9e4369b68ab5cf04016dc3717810e28a9900567009d8b7f51d086605ce900531",
  #"7ba15a98acebe8db1e061e7b3ef6cd31159e1e7962977d72104b81459765c319",
  #"e0e49239fbc4a677b00ab42859a54ad473aab67ec5bbb520d649ae1e7709ebd4",
  #"89ed6bcdd536d5d9703b61ae0336e2d0be77273beaef92b0f96d310a3ec26df2",
  #"3fdccfa66e0386a4f365b6089aee113d7ccc9591eb1edf02405142f9812f4c9d",
  #"2d3aa9cab7f6e4ae88884460088894ef74ab6afab4daa23ff922e490da7de86f",
  #"d1596816e15aaa672d6bddb22eeca7ebeda94d83bd0d18fe0dbc9753f60ef733",
  #"149235a8da7692f56e03feb4df787f0dfc577f341998662e84461fe7d5e7d2be",
  #"418e5310128b55f85e8f0fa6c11a236ca08a8d74f3544b731a75e68d2d3915f8",
  #"ae61c20a73b96ebbccd99d6194469aa4bafc92152eb2065c6f86dbf60235943a",
  #"b4b4c80150a0737d684d9a959aca1fbd4f745b8deb9323feb619c24c1f4cac4b",
  #"d816ce7354f93e04703cf8412bcd8fe800044e424d9ef665d327259e682dd163",
  #"04c733e68aeb11245f4eaccc03cebe44835b5622877ed6c50c783c0489876126",
  #"9875b3e62e23440994face849e2e776576b07f0da3497fcaf10353fac37eb56e",
  #"1dddd34459c494ce0cbbb7ecd4871cc0c758dbee06a40e9a57069e32efdd35b3",
  #"91f881bc3bcbd580946b461fb5d7e9af760326820f85def066defec872fbe426",
]

test cs_d20_leaf_x17_insert_a() {
  insert_ok_a(d20_leaf_x17_old, d20_leaf_x17_new, d20_leaf_x17_key, Leaf(#"1a1c1a4555b50af0d3d587903a9c5dfea7114b0a7781679733d1ce5a9f3d9191"), d20_leaf_x17_sibs)
}

test cs_d20_leaf_x17_insert_b() {
  insert_ok_b(d20_leaf_x17_old, d20_leaf_x17_new, d20_leaf_x17_key, Leaf(#"1a1c1a4555b50af0d3d587903a9c5dfea7114b0a7781679733d1ce5a9f3d9191"), d20_leaf_x17_rev, 20)
}

test cs_d20_leaf_x17_absent_a() {
  absent_ok_a(d20_leaf_x17_old, d20_leaf_x17_key, Leaf(#"1a1c1a4555b50af0d3d587903a9c5dfea7114b0a7781679733d1ce5a9f3d9191"), d20_leaf_x17_sibs)
}

test cs_d20_leaf_x17_bogus_new_a() fail {
  insert_ok_a(d20_leaf_x17_old, d20_leaf_x17_bogus, d20_leaf_x17_key, Leaf(#"1a1c1a4555b50af0d3d587903a9c5dfea7114b0a7781679733d1ce5a9f3d9191"), d20_leaf_x17_sibs)
}

test cs_d20_leaf_x17_bogus_new_b() fail {
  insert_ok_b(d20_leaf_x17_old, d20_leaf_x17_bogus, d20_leaf_x17_key, Leaf(#"1a1c1a4555b50af0d3d587903a9c5dfea7114b0a7781679733d1ce5a9f3d9191"), d20_leaf_x17_rev, 20)
}

pub type ProbeRedeemer {
  terminal: Terminal,
  rev_siblings: List<ByteArray>,
  depth: Int,
}

test cs_d10_leaf_redeemer_cbor_len() {
  let r = ProbeRedeemer { terminal: Leaf(d10_leaf_key), rev_siblings: d10_leaf_rev, depth: 10 }
  trace bytearray.length(cbor.serialise(r))
  bytearray.length(cbor.serialise(r)) == 384
}

test cs_d20_leaf_redeemer_cbor_len() {
  let r = ProbeRedeemer { terminal: Leaf(d20_leaf_key), rev_siblings: d20_leaf_rev, depth: 20 }
  trace bytearray.length(cbor.serialise(r))
  bytearray.length(cbor.serialise(r)) == 724
}

test cs_d27_leaf_redeemer_cbor_len() {
  let r = ProbeRedeemer { terminal: Leaf(d27_leaf_key), rev_siblings: d27_leaf_rev, depth: 27 }
  trace bytearray.length(cbor.serialise(r))
  bytearray.length(cbor.serialise(r)) == 963
}

test cs_d27_empty_redeemer_cbor_len() {
  let r = ProbeRedeemer { terminal: Empty, rev_siblings: d27_empty_rev, depth: 27 }
  trace bytearray.length(cbor.serialise(r))
  bytearray.length(cbor.serialise(r)) == 928
}

test cs_d64_leaf_redeemer_cbor_len() {
  let r = ProbeRedeemer { terminal: Leaf(d64_leaf_key), rev_siblings: d64_leaf_rev, depth: 64 }
  trace bytearray.length(cbor.serialise(r))
  bytearray.length(cbor.serialise(r)) == 2221
}

test cs_d255_leaf_redeemer_cbor_len() {
  let r = ProbeRedeemer { terminal: Leaf(d255_leaf_key), rev_siblings: d255_leaf_rev, depth: 255 }
  trace bytearray.length(cbor.serialise(r))
  bytearray.length(cbor.serialise(r)) == 8715
}
