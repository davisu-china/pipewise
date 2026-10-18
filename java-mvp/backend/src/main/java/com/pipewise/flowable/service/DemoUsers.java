package com.pipewise.flowable.service;

import java.util.List;

/** 骨架阶段的演示账号。生产应替换为 SSO/OIDC + 组织服务。 */
public final class DemoUsers {

    public record DemoUser(String id, String name) {
    }

    public static final List<DemoUser> USERS = List.of(
            new DemoUser("u_zhangsan", "张三（发起人）"),
            new DemoUser("u_lisi", "李四（主管）"),
            new DemoUser("u_wangfang", "王芳（HR）"),
            new DemoUser("u_zhangwei", "张伟（总监）"),
            new DemoUser("u_admin", "管理员")
    );

    private DemoUsers() {
    }

    public static boolean exists(String userId) {
        return USERS.stream().anyMatch(u -> u.id().equals(userId));
    }
}
