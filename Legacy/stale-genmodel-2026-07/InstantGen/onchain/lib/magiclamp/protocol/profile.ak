// lib/profile.ak — Lazy profile change apply (SPEC_V1 §2)
//
// `UpdateProfile` sets `pending_profile = Some(PendingProfile { new, eff })`.
// The profile field stays unchanged until a subsequent handler sees
// `current_epoch >= eff` and applies it via this helper.
//
// Handler usage (MANDATORY pattern — see SPEC_V1 §2):
//   let applied_input = apply_pending_profile(input_datum, current_epoch)
//   // 1. Use applied_input.profile for M computation
//   // 2. Use applied_input.profile / applied_input.pending_profile
//   //    for the A02 output datum check
//
// Using applied_input only for M but NOT for output datum check leaves
// pending_profile in the output → next tx applies again → infinite
// pending bug.

use magiclamp/protocol/types.{VaultDatum}

pub fn apply_pending_profile(
  datum         : VaultDatum,
  current_epoch : Int,
) -> VaultDatum {
  when datum.pending_profile is {
    Some(pp) ->
      if current_epoch >= pp.effective_epoch {
        VaultDatum {
          ..datum,
          profile:         pp.new_profile,
          pending_profile: None,
        }
      } else {
        datum
      }
    None -> datum
  }
}
