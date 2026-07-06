---
paths:
  - "**/*.swift"
  - "**/Package.swift"
---
# Swift Patterns

> This file extends common/patterns.md (../common/patterns.md) with Swift specific content.

## Protocol-Oriented Design

Define small, focused protocols. Use protocol extensions for shared defaults:

```swift
protocol Repository: Sendable {
    associatedtype Item: Identifiable & Sendable
    func find(by id: Item.ID) async throws -> Item?
    func save(_ item: Item) async throws
}
```

## Value Types

- Use structs for data transfer objects and models
- Use enums with associated values to model distinct states:

```swift
enum LoadState<T: Sendable>: Sendable {
    case idle
    case loading
    case loaded(T)
    case failed(Error)
}
```

## Actor Pattern

Use actors for shared mutable state instead of locks or dispatch queues:

```swift
actor Cache<Key: Hashable & Sendable, Value: Sendable> {
    private var storage: [Key: Value] = [:]

    func get(_ key: Key) -> Value? { storage[key] }
    func set(_ key: Key, value: Value) { storage[key] = value }
}
```

## Dependency Injection

Inject protocols with default parameters — production uses defaults, tests inject mocks:

```swift
struct UserService {
    private let repository: any UserRepository

    init(repository: any UserRepository = DefaultUserRepository()) {
        self.repository = repository
    }
}
```

## Contract Definition

Use `protocol` for contracts; `struct` for DTOs; `async throws` for async I/O:

```swift
protocol TaskApi {
    func createTask(_ input: CreateTaskInput) async throws -> Task
    func listTasks(_ params: ListTasksParams) async throws -> Paged<Task>
    func getTask(_ id: String) async throws -> Task
    func updateTask(_ id: String, _ input: UpdateTaskInput) async throws -> Task
    func deleteTask(_ id: String) async throws
}

struct CreateTaskInput: Codable {
    var title: String
    var description: String?
}

struct Task: Codable {
    var id: String
    var title: String
    var description: String?
    var createdAt: Date
    var updatedAt: Date
    var createdBy: String
}
```

## Error Representation

Use a single `Error`-conforming enum; throw from APIs, map to the universal
REST envelope (`{ code, message, details? }`) in the HTTP layer:

```swift
enum ApiError: Error {
    case validation([FieldError])
    case notFound(String)
    case conflict(String)
}
```

## Boundary Validation

Decode with `Codable` at the edge, then validate. Internal code trusts the
parsed value:

```swift
func create(_ req: Request) async throws -> Task {
    let input = try req.content.decode(CreateTaskInput.self)
    guard !input.title.isEmpty, input.title.count <= 200 else {
        throw ApiError.validation([.init(field: "title", message: "1..200 chars")])
    }
    return try await svc.create(input)
}
```

## Additive Evolution

- New struct fields must be `Optional` (or carry a default in a memberwise init)
  so old payloads decode.
- Adding a non-optional `Codable` field is a breaking decode change.
- Do not change a field's type or rename a coding key without a custom
  `init(from:)` / `encode(to:)` migration.
- For protocols, adding a requirement is breaking for any external conformer.

## Variant Types

Use enums with associated values:

```swift
enum TaskStatus: Codable {
    case pending
    case inProgress(assignee: String, startedAt: Date)
    case completed(completedAt: Date, completedBy: String)
    case cancelled(reason: String, cancelledAt: Date)

    var label: String {
        switch self {
        case .pending: return "Pending"
        case .inProgress(let a, _): return "In progress (\(a))"
        case .completed(let d, _): return "Done on \(d)"
        case .cancelled(let r, _): return "Cancelled: \(r)"
        }
    }
}
```

## Input/Output Separation

Separate request structs from response structs (server-generated fields on the
output). See `CreateTaskInput` vs `Task` in Contract Definition above.

## Opaque IDs

Use `RawRepresentable` structs so distinct IDs are not interchangeable:

```swift
struct TaskId: Hashable, Codable, RawRepresentable { let rawValue: String }
struct UserId: Hashable, Codable, RawRepresentable { let rawValue: String }

func getTask(_ id: TaskId) async throws -> Task
```
