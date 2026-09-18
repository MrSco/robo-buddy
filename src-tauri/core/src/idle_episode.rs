/// One automatic start per input episode, including capture failures and watchdog exits.
#[derive(Default)]
pub struct IdleEpisode(Option<u32>);

impl IdleEpisode {
    pub fn should_start(&mut self, input: u32, idle: f64, minutes: f64, up: bool, blocked: bool) -> bool {
        if up { self.0 = Some(input); return false; }
        if blocked || !minutes.is_finite() || minutes <= 0.0 || idle < minutes * 60.0 || self.0 == Some(input) { return false; }
        self.0 = Some(input);
        true
    }
}

pub fn elapsed(now: u32, input: u32) -> f64 { now.wrapping_sub(input) as f64 / 1000.0 }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failure_waits_for_new_input_before_retrying() {
        let mut episode = IdleEpisode::default();
        assert!(!episode.should_start(10, 59.0, 1.0, false, false));
        assert!(episode.should_start(10, 60.0, 1.0, false, false));
        assert!(!episode.should_start(10, 600.0, 1.0, false, false));
        assert!(!episode.should_start(20, 1.0, 1.0, false, false));
        assert!(episode.should_start(20, 60.0, 1.0, false, false));
    }
    #[test]
    fn fullscreen_does_not_consume_the_attempt() {
        let mut episode = IdleEpisode::default();
        assert!(!episode.should_start(10, 60.0, 1.0, false, true));
        assert!(episode.should_start(10, 61.0, 1.0, false, false));
    }
    #[test]
    fn manual_saver_and_small_input_do_not_immediately_restart() {
        let mut episode = IdleEpisode::default();
        assert!(!episode.should_start(10, 60.0, 1.0, true, false));
        assert!(!episode.should_start(11, 60.0, 1.0, true, false));
        assert!(!episode.should_start(11, 61.0, 1.0, false, false));
    }
    #[test]
    fn clock_rollover_and_disabled_setting() {
        assert_eq!(elapsed(999, u32::MAX), 1.0);
        let mut episode = IdleEpisode::default();
        for minutes in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(!episode.should_start(10, 600.0, minutes, false, false));
        }
    }
}
