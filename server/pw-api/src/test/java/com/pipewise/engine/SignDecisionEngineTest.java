package com.pipewise.engine;

import com.pipewise.engine.SignDecisionEngine.Outcome;
import com.pipewise.engine.SignDecisionEngine.SessionState;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class SignDecisionEngineTest {

    @Test
    void anyApprovesOnFirstApprove() {
        assertThat(evaluate("ANY", "ALL", null, "VETO_IMMEDIATE", 3, 1, 1, 0, "approve"))
                .isEqualTo(Outcome.APPROVE);
    }

    @Test
    void anyKeepsWaitingWhenSomeoneRejects() {
        assertThat(evaluate("ANY", "ALL", null, "VETO_IMMEDIATE", 3, 1, 0, 1, "reject"))
                .isEqualTo(Outcome.WAIT);
    }

    @Test
    void anyRejectsWhenAllReject() {
        assertThat(evaluate("ANY", "ALL", null, "VETO_IMMEDIATE", 3, 3, 0, 3, "reject"))
                .isEqualTo(Outcome.REJECT);
    }

    @Test
    void allWaitsUntilEveryoneApproves() {
        assertThat(evaluate("ALL", "ALL", null, "VETO_IMMEDIATE", 3, 2, 2, 0, "approve"))
                .isEqualTo(Outcome.WAIT);
        assertThat(evaluate("ALL", "ALL", null, "VETO_IMMEDIATE", 3, 3, 3, 0, "approve"))
                .isEqualTo(Outcome.APPROVE);
    }

    @Test
    void allVetoRejectsImmediately() {
        assertThat(evaluate("ALL", "ALL", null, "VETO_IMMEDIATE", 3, 1, 0, 1, "reject"))
                .isEqualTo(Outcome.REJECT);
    }

    @Test
    void allRatioApprovesWhenThresholdReached() {
        assertThat(evaluate("ALL", "RATIO", 0.6, "VETO_IMMEDIATE", 3, 2, 2, 0, "approve"))
                .isEqualTo(Outcome.APPROVE);
    }

    @Test
    void raceFirstVerdictWins() {
        assertThat(evaluate("RACE", "ALL", null, "VETO_IMMEDIATE", 3, 1, 1, 0, "approve"))
                .isEqualTo(Outcome.APPROVE);
        assertThat(evaluate("RACE", "ALL", null, "VETO_IMMEDIATE", 3, 1, 0, 1, "reject"))
                .isEqualTo(Outcome.REJECT);
    }

    private Outcome evaluate(String mode, String passRule, Double ratio, String rejectRule,
                             int expected, int completed, int approve, int reject, String lastVerdict) {
        return SignDecisionEngine.evaluate(
                new SessionState(mode, passRule, ratio, rejectRule, expected, completed, approve, reject),
                lastVerdict);
    }
}
