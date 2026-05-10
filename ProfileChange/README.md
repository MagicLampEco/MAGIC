# ProfileChange
## GenMAGIC v3.3 · §12 · C-PC-V1..6 · T4

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
