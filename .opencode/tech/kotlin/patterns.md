---
paths:
  - "**/*.kt"
  - "**/*.kts"
---
# Kotlin Patterns

> This file extends common/patterns.md (../common/patterns.md) with Kotlin and Android/KMP-specific content.

## Dependency Injection

Prefer constructor injection. Use Koin (KMP) or Hilt (Android-only):

```kotlin
// Koin — declare modules
val dataModule = module {
    single<ItemRepository> { ItemRepositoryImpl(get(), get()) }
    factory { GetItemsUseCase(get()) }
    viewModelOf(::ItemListViewModel)
}

// Hilt — annotations
@HiltViewModel
class ItemListViewModel @Inject constructor(
    private val getItems: GetItemsUseCase
) : ViewModel()
```

## ViewModel Pattern

Single state object, event sink, one-way data flow:

```kotlin
data class ScreenState(
    val items: List<Item> = emptyList(),
    val isLoading: Boolean = false
)

class ScreenViewModel(private val useCase: GetItemsUseCase) : ViewModel() {
    private val _state = MutableStateFlow(ScreenState())
    val state = _state.asStateFlow()

    fun onEvent(event: ScreenEvent) {
        when (event) {
            is ScreenEvent.Load -> load()
            is ScreenEvent.Delete -> delete(event.id)
        }
    }
}
```

## Repository Pattern

- `suspend` functions return `Result<T>` or custom error type
- `Flow` for reactive streams
- Coordinate local + remote data sources

```kotlin
interface ItemRepository {
    suspend fun getById(id: String): Result<Item>
    suspend fun getAll(): Result<List<Item>>
    fun observeAll(): Flow<List<Item>>
}
```

## UseCase Pattern

Single responsibility, `operator fun invoke`:

```kotlin
class GetItemUseCase(private val repository: ItemRepository) {
    suspend operator fun invoke(id: String): Result<Item> {
        return repository.getById(id)
    }
}

class GetItemsUseCase(private val repository: ItemRepository) {
    suspend operator fun invoke(): Result<List<Item>> {
        return repository.getAll()
    }
}
```

## expect/actual (KMP)

Use for platform-specific implementations:

```kotlin
// commonMain
expect fun platformName(): String
expect class SecureStorage {
    fun save(key: String, value: String)
    fun get(key: String): String?
}

// androidMain
actual fun platformName(): String = "Android"
actual class SecureStorage {
    actual fun save(key: String, value: String) { /* EncryptedSharedPreferences */ }
    actual fun get(key: String): String? = null /* ... */
}

// iosMain
actual fun platformName(): String = "iOS"
actual class SecureStorage {
    actual fun save(key: String, value: String) { /* Keychain */ }
    actual fun get(key: String): String? = null /* ... */
}
```

## Coroutine Patterns

- Use `viewModelScope` in ViewModels, `coroutineScope` for structured child work
- Use `stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), initialValue)` for StateFlow from cold Flows
- Use `supervisorScope` when child failures should be independent

## Builder Pattern with DSL

```kotlin
class HttpClientConfig {
    var baseUrl: String = ""
    var timeout: Long = 30_000
    private val interceptors = mutableListOf<Interceptor>()

    fun interceptor(block: () -> Interceptor) {
        interceptors.add(block())
    }
}

fun httpClient(block: HttpClientConfig.() -> Unit): HttpClient {
    val config = HttpClientConfig().apply(block)
    return HttpClient(config)
}

// Usage
val client = httpClient {
    baseUrl = "https://api.example.com"
    timeout = 15_000
    interceptor { AuthInterceptor(tokenProvider) }
}
```

## Contract Definition

Define the interface before implementation. Use `interface` for contracts and
`data class` for DTOs. Mark async I/O `suspend`:

```kotlin
interface TaskAPI {
    suspend fun createTask(input: CreateTaskInput): Task
    suspend fun listTasks(params: ListTasksParams): PaginatedResult<Task>
    suspend fun getTask(id: String): Task
    suspend fun updateTask(id: String, input: UpdateTaskInput): Task
    suspend fun deleteTask(id: String)
}

data class CreateTaskInput(
    val title: String,
    val description: String? = null,
)

data class Task(
    val id: String,
    val title: String,
    val description: String?,
    val createdAt: Instant,
    val updatedAt: Instant,
    val createdBy: String,
)
```

## Error Representation

Use a sealed class hierarchy for typed errors; map to the universal REST
envelope (`{ code, message, details? }`) at the controller boundary. Pick one
strategy in app code (throw typed errors, or return `Result<T>`) and do not mix:

```kotlin
sealed class ApiError {
    data class Validation(val details: List<ErrorDetail>) : ApiError()
    data class NotFound(val id: String) : ApiError()
    data class Conflict(val message: String) : ApiError()
}

fun ApiError.toResponse() = when (this) {
    is ApiError.Validation -> ResponseEntity.status(422).body(mapOf(
        "error" to mapOf("code" to "VALIDATION_ERROR", "details" to details)
    ))
    is ApiError.NotFound  -> ResponseEntity.status(404).body(mapOf(
        "error" to mapOf("code" to "NOT_FOUND", "message" to "Task $id not found")
    ))
    is ApiError.Conflict  -> ResponseEntity.status(409).body(mapOf(
        "error" to mapOf("code" to "CONFLICT", "message" to message)
    ))
}
```

## Boundary Validation

Validate at the controller boundary, then trust types internally. Use bean
validation (`jakarta.validation` / Spring `@Valid`) or kotlinx.serialization:

```kotlin
@PostMapping("/tasks")
fun create(@Valid @RequestBody input: CreateTaskInput): ResponseEntity<Task> {
    val task = taskService.create(input)
    return ResponseEntity.status(201).body(task)
}
```

## Additive Evolution

- Add new fields with a default or as nullable (`val x: String? = null`) so
  existing callers compile and old JSON deserializes.
- `val x: String` (non-null, no default) is *required* — adding one is breaking.
- Flipping `String` to `String?` is breaking for consumers that narrow on non-null.
- Deprecate with `@Deprecated("...", ReplaceWith("..."))` before removal.

## Variant Types

Use sealed classes for sum types — exhaustive `when` gives compile-time safety:

```kotlin
sealed class TaskStatus {
    object Pending : TaskStatus()
    data class InProgress(val assignee: String, val startedAt: Instant) : TaskStatus()
    data class Completed(val completedAt: Instant, val completedBy: String) : TaskStatus()
    data class Cancelled(val reason: String, val cancelledAt: Instant) : TaskStatus()
}

fun statusLabel(s: TaskStatus): String = when (s) {
    is TaskStatus.Pending   -> "Pending"
    is TaskStatus.InProgress -> "In progress (${s.assignee})"
    is TaskStatus.Completed  -> "Done on ${s.completedAt}"
    is TaskStatus.Cancelled  -> "Cancelled: ${s.reason}"
}
```

## Input/Output Separation

Separate request DTOs (caller-provided) from response DTOs (server-generated
fields included). See `CreateTaskInput` vs `Task` in Contract Definition above.

## Opaque IDs

Use `@JvmInline value class` so distinct IDs are not interchangeable:

```kotlin
@JvmInline value class TaskId(val value: String)
@JvmInline value class UserId(val value: String)

suspend fun getTask(id: TaskId): Task
```
