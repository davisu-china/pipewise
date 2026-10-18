package com.pipewise.engine;

/**
 * 签核裁决的纯函数：不碰数据库，便于用决策表单测。
 */
public final class SignDecisionEngine {

    private SignDecisionEngine() {
    }

    public enum Outcome {
        WAIT, APPROVE, REJECT
    }

    public record SessionState(
            String mode,
            String passRuleType,
            Double ratio,
            String rejectRule,
            int expected,
            int completed,
            int approve,
            int reject) {
    }

    public static Outcome evaluate(SessionState session, String lastVerdict) {
        return switch (session.mode()) {
            case "RACE" -> "approve".equals(lastVerdict) ? Outcome.APPROVE : Outcome.REJECT;
            case "ANY" -> {
                if (session.approve() > 0) {
                    yield Outcome.APPROVE;
                }
                if (session.completed() >= session.expected()) {
                    yield Outcome.REJECT;
                }
                yield Outcome.WAIT;
            }
            case "ALL" -> {
                if (session.reject() > 0 && "VETO_IMMEDIATE".equals(session.rejectRule())) {
                    yield Outcome.REJECT;
                }
                if ("RATIO".equals(session.passRuleType())) {
                    double ratio = session.ratio() == null ? 1.0 : session.ratio();
                    int needed = (int) Math.ceil(session.expected() * ratio - 1e-9);
                    if (session.approve() >= needed) {
                        yield Outcome.APPROVE;
                    }
                } else if (session.approve() >= session.expected()) {
                    yield Outcome.APPROVE;
                }
                if (session.completed() >= session.expected()) {
                    yield Outcome.REJECT;
                }
                yield Outcome.WAIT;
            }
            default -> throw new IllegalArgumentException("unknown sign mode: " + session.mode());
        };
    }
}
