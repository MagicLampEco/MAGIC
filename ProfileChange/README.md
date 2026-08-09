# ProfileChange
## GenMAGIC v3.3 · §12 · C-PC-V1..6 · T4

> **Module MỒ CÔI — chưa được quyết hội tụ hay dời `Legacy/`.** Xem
> [`DEVSTATUS.md`](../DEVSTATUS.md). Nguồn chân lý mô hình:
> [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](../SPEC/MagicLamp-Tripletoken-Feat-(Vi).md);
> số mục "§12" là di sản đánh số GenMAGIC v3.3, không phải mục lục spec canonical.
> Validator ở đây là **script hash RIÊNG** (`vault_profile`), nên UTxO nằm ở địa chỉ vault
> InstantGen **không bao giờ chạy** validator này — đọc tài liệu này như mô tả một vault
> dùng chung là dựng tx không ai spend được. Vault đang sống duy nhất dùng profile là
> **InstantGen**.

---

## Luồng 2-step (lazy)

```
Tx 1 (UpdateProfile):  pending_profile = Some{Lantern, effective: e+1}
                        profile vẫn = Ember (chưa đổi)

Tx 2 (bất kỳ vault tx): nếu pending.effective_epoch ≤ current → apply, clear pending
                          profile = Lantern ✓
```

---

## Quy tắc quan trọng (T4, C-PC-V4/6)

**Snapshot batches đã sinh giữ `profile_at_creation` gốc — KHÔNG thay đổi.**

```
Ví dụ: batch sinh ep95 với profile=Flame (N=6, decay ×0.8)
        User đổi sang Ember tại ep100 (effective ep101)
        Batch tại ep101: vẫn dùng Flame N=6, k=6 → expired ✓
        
        KHÔNG thể "kéo dài" batch Ember (N=3) bằng cách đổi sang Lantern (N=9).
```

---

## Cooldown

- `PROFILE_CHANGE_COOLDOWN = 2 epoch` [Significant]
- Không thể đổi liên tiếp quá nhanh

---

## Usage

```typescript
import { buildProfileChangeTx, canChangeProfile } from "@magiclamp/profilechange";

// Check cooldown trước
const { allowed, waitEpochs } = canChangeProfile(
  vault.profile_changed_epoch,
  currentEpoch,
);
if (!allowed) console.log(`Wait ${waitEpochs} more epoch(s)`);

// Build tx
const result = await buildProfileChangeTx(lucid, vaultUtxo, "Lantern", VaultDatumSchema, scriptHash);
console.log(result.summary);
// Effective: epoch 101 (next tx that touches vault)
// ⚠ Existing batches KEEP original profile (T4)
```

---

## Tests

```bash
cd offchain && npm install && npm test
```
