package com.pipewise.flowable.api;

import com.pipewise.flowable.service.DemoUsers;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/users")
public class UserController {

    @GetMapping
    public List<Dtos.UserDto> users() {
        return DemoUsers.USERS.stream()
                .map(u -> new Dtos.UserDto(u.id(), u.name()))
                .toList();
    }
}
