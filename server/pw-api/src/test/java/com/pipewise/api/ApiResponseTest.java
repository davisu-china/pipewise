package com.pipewise.api;

import com.pipewise.common.api.ApiResponse;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ApiResponseTest {

    @Test
    void okCarriesDataAndTraceId() {
        ApiResponse<String> response = ApiResponse.ok("pong", "trace-1");

        assertThat(response.success()).isTrue();
        assertThat(response.data()).isEqualTo("pong");
        assertThat(response.error()).isNull();
        assertThat(response.traceId()).isEqualTo("trace-1");
    }

    @Test
    void failCarriesStableCode() {
        ApiResponse<Void> response = ApiResponse.fail("VALIDATION_FAILED", "bad input", "trace-2");

        assertThat(response.success()).isFalse();
        assertThat(response.data()).isNull();
        assertThat(response.error()).isNotNull();
        assertThat(response.error().code()).isEqualTo("VALIDATION_FAILED");
        assertThat(response.traceId()).isEqualTo("trace-2");
    }
}
