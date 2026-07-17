// lib/profile.ak — Lazy profile change apply (SPEC_V1 §2)
//
// `UpdateProfile` sets `pending_profile = Some(PendingProfile { new, eff })`.
// The new profile field stays unchanged until a subsequent handler
// (TriggerSnapshot, etc.) sees `current_epoch >= eff` and applies it.
//
// Handler usage (MANDATORY pattern — see SPEC_V1 §2):
//   let applied_input = apply_pending_profile(input_datum, current_epoch)
//   // 1. Use applied_input for M computation
//   // 2. Use applied_input.profile / applied_input.pending_profile
//   //    for the A02 output datum check
//
// If applied_input is used only for M but NOT for output datum check,
// the output retains pending_profile → next tx applies again → infinite
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
