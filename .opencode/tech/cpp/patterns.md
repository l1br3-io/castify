---
paths:
  - "**/*.cpp"
  - "**/*.hpp"
  - "**/*.cc"
  - "**/*.hh"
  - "**/*.cxx"
  - "**/*.h"
  - "**/CMakeLists.txt"
---
# C++ Patterns

> This file extends common/patterns.md (../common/patterns.md) with C++ specific content.

## RAII (Resource Acquisition Is Initialization)

Tie resource lifetime to object lifetime:

```cpp
class FileHandle {
public:
    explicit FileHandle(const std::string& path) : file_(std::fopen(path.c_str(), "r")) {}
    ~FileHandle() { if (file_) std::fclose(file_); }
    FileHandle(const FileHandle&) = delete;
    FileHandle& operator=(const FileHandle&) = delete;
private:
    std::FILE* file_;
};
```

## Rule of Five/Zero

- **Rule of Zero**: Prefer classes that need no custom destructor, copy/move constructors, or assignments
- **Rule of Five**: If you define any of destructor/copy-ctor/copy-assign/move-ctor/move-assign, define all five

## Value Semantics

- Pass small/trivial types by value
- Pass large types by `const&`
- Return by value (rely on RVO/NRVO)
- Use move semantics for sink parameters

## Error Handling

- Use exceptions for exceptional conditions
- Use `std::optional` for values that may not exist
- Use `std::expected` (C++23) or result types for expected failures

## Contract Definition

Use an abstract class (pure virtual) for contracts; POD structs for DTOs:

```cpp
class TaskApi {
public:
    virtual ~TaskApi() = default;
    virtual std::future<Task> create_task(CreateTaskInput input) = 0;
    virtual std::future<Paged<Task>> list_tasks(ListTasksParams params) = 0;
    virtual std::future<Task> get_task(std::string id) = 0;
    virtual std::future<Task> update_task(std::string id, UpdateTaskInput input) = 0;
    virtual std::future<void> delete_task(std::string id) = 0;
};
```

## Error Representation

Use `std::expected<T, E>` (C++23) or `tl::expected` for expected failures at
boundaries; exceptions for truly exceptional conditions. Single error type per
module:

```cpp
enum class ApiErrorKind { Validation, NotFound, Conflict };

struct ApiError {
    ApiErrorKind kind;
    std::string message;
    std::vector<FieldError> details;
};

using ApiResult = std::expected<Task, ApiError>;
```

## Boundary Validation

Parse and validate at the API/transport boundary; internal code trusts the
parsed struct. Use a JSON library (e.g. `simdjson`, `nlohmann::json`) + a
validator:

```cpp
std::expected<CreateTaskInput, ApiError> parse_create(const std::string& body) {
    auto j = nlohmann::json::parse(body);  // wrap in try in real code
    CreateTaskInput in;
    in.title = j.at("title").get<std::string>();
    if (in.title.empty() || in.title.size() > 200)
        return std::unexpected(ApiError{ApiErrorKind::Validation, "invalid title", {}});
    if (j.contains("description"))
        in.description = j["description"].get<std::string>();
    return in;
}
```

## Additive Evolution

- New fields must be `std::optional<T>` and decoded defensively (check presence
  first) so old payloads still parse.
- Adding a required field is a breaking change.
- C++ ABI is fragile: adding members changes struct layout — keep DTOs as
  transport types, not as stable across-ABI surfaces.
- Do not change a field's type or meaning; mark removals with `[[deprecated]]`.

## Variant Types

Use `std::variant` + `std::visit`:

```cpp
struct Pending {};
struct InProgress { std::string assignee; std::chrono::system_clock::time_point started_at; };
struct Completed { std::chrono::system_clock::time_point completed_at; std::string completed_by; };
struct Cancelled { std::string reason; std::chrono::system_clock::time_point cancelled_at; };

using TaskStatus = std::variant<Pending, InProgress, Completed, Cancelled>;

std::string label(const TaskStatus& s) {
    return std::visit([](const auto& v) -> std::string {
        using T = std::decay_t<decltype(v)>;
        if constexpr (std::is_same_v<T, Pending>) return "Pending";
        else if constexpr (std::is_same_v<T, InProgress>) return "In progress (" + v.assignee + ")";
        else if constexpr (std::is_same_v<T, Completed>) return "Done";
        else return "Cancelled: " + v.reason;
    }, s);
}
```

## Input/Output Separation

Separate request structs from response structs:

```cpp
struct CreateTaskInput {
    std::string title;
    std::optional<std::string> description;
};

struct Task {
    std::string id;
    std::string title;
    std::optional<std::string> description;
    std::chrono::system_clock::time_point created_at;
    std::chrono::system_clock::time_point updated_at;
    std::string created_by;
};
```

## Opaque IDs

Use strong types (e.g. `NamedType` / a small wrapper) so distinct IDs are not
interchangeable:

```cpp
struct TaskId { std::string value; };
struct UserId { std::string value; };

std::future<Task> get_task(TaskId id);
```
