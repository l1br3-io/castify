---
paths:
  - "**/*.java"
---
# Java Patterns

> This file extends common/patterns.md (../common/patterns.md) with Java-specific content.

## Repository Pattern

Encapsulate data access behind an interface:

```java
public interface OrderRepository {
    Optional<Order> findById(Long id);
    List<Order> findAll();
    Order save(Order order);
    void deleteById(Long id);
}
```

Concrete implementations handle storage details (JPA, JDBC, in-memory for tests).

## Service Layer

Business logic in service classes; keep controllers and repositories thin:

```java
public class OrderService {
    private final OrderRepository orderRepository;
    private final PaymentGateway paymentGateway;

    public OrderService(OrderRepository orderRepository, PaymentGateway paymentGateway) {
        this.orderRepository = orderRepository;
        this.paymentGateway = paymentGateway;
    }

    public OrderSummary placeOrder(CreateOrderRequest request) {
        var order = Order.from(request);
        paymentGateway.charge(order.total());
        var saved = orderRepository.save(order);
        return OrderSummary.from(saved);
    }
}
```

## Constructor Injection

Always use constructor injection — never field injection:

```java
// GOOD — constructor injection (testable, immutable)
public class NotificationService {
    private final EmailSender emailSender;

    public NotificationService(EmailSender emailSender) {
        this.emailSender = emailSender;
    }
}

// BAD — field injection (untestable without reflection, requires framework magic)
public class NotificationService {
    @Inject // or @Autowired
    private EmailSender emailSender;
}
```

## DTO Mapping

Use records for DTOs. Map at service/controller boundaries:

```java
public record OrderResponse(Long id, String customer, BigDecimal total) {
    public static OrderResponse from(Order order) {
        return new OrderResponse(order.getId(), order.getCustomerName(), order.getTotal());
    }
}
```

## Builder Pattern

Use for objects with many optional parameters:

```java
public class SearchCriteria {
    private final String query;
    private final int page;
    private final int size;
    private final String sortBy;

    private SearchCriteria(Builder builder) {
        this.query = builder.query;
        this.page = builder.page;
        this.size = builder.size;
        this.sortBy = builder.sortBy;
    }

    public static class Builder {
        private String query = "";
        private int page = 0;
        private int size = 20;
        private String sortBy = "id";

        public Builder query(String query) { this.query = query; return this; }
        public Builder page(int page) { this.page = page; return this; }
        public Builder size(int size) { this.size = size; return this; }
        public Builder sortBy(String sortBy) { this.sortBy = sortBy; return this; }
        public SearchCriteria build() { return new SearchCriteria(this); }
    }
}
```

## Sealed Types for Domain Models

```java
public sealed interface PaymentResult permits PaymentSuccess, PaymentFailure {
    record PaymentSuccess(String transactionId, BigDecimal amount) implements PaymentResult {}
    record PaymentFailure(String errorCode, String message) implements PaymentResult {}
}

// Exhaustive handling (Java 21+)
String message = switch (result) {
    case PaymentSuccess s -> "Paid: " + s.transactionId();
    case PaymentFailure f -> "Failed: " + f.errorCode();
};
```

## API Response Envelope

Consistent API responses:

```java
public record ApiResponse<T>(boolean success, T data, String error) {
    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>(true, data, null);
    }
    public static <T> ApiResponse<T> error(String message) {
        return new ApiResponse<>(false, null, message);
    }
}
```

## Contract Definition

Use `interface` for contracts and `record` for DTOs:

```java
public interface TaskApi {
    Task createTask(CreateTaskInput input);
    Paged<Task> listTasks(ListTasksParams params);
    Task getTask(String id);
    Task updateTask(String id, UpdateTaskInput input);
    void deleteTask(String id);
}

public record CreateTaskInput(String title, String description) {}
public record Task(
    String id,
    String title,
    String description,
    Instant createdAt,
    Instant updatedAt,
    String createdBy
) {}
```

## Error Representation

Use a single exception hierarchy; map to the universal REST envelope
(`{ code, message, details? }`) via `@ControllerAdvice`. Do not mix throwing
and returning `null`/`Optional` for the same operation:

```java
public abstract class ApiException extends RuntimeException {
    public abstract String getCode();
}

public final class ValidationException extends ApiException {
    private final List<FieldError> details;
    public ValidationException(List<FieldError> details) { this.details = details; }
    public String getCode()   { return "VALIDATION_ERROR"; }
    public List<FieldError> getDetails() { return details; }
}

public final class NotFoundException extends ApiException {
    private final String id;
    public NotFoundException(String id) { this.id = id; }
    public String getCode() { return "NOT_FOUND"; }
}
```

## Boundary Validation

Use Bean Validation (`jakarta.validation`) at the controller boundary, then
trust the types internally:

```java
@PostMapping("/tasks")
public ResponseEntity<Task> create(@Valid @RequestBody CreateTaskInput input) {
    Task task = svc.create(input);
    return ResponseEntity.status(201).body(task);
}

public record CreateTaskInput(
    @NotBlank @Size(max = 200) String title,
    @Size(max = 2000) String description
) {}
```

## Additive Evolution

- Add new record components with a default in the canonical constructor, or
  expose a secondary factory; existing callers of the old signature keep
  compiling.
- Removing or reordering record components is breaking — external code reads
  them positionally.
- For JSON DTOs, ensure Jackson tolerates unknown properties
  (`@JsonIgnoreProperties(ignoreUnknown = true)`) so new server fields don't
  break old clients.
- Annotate removals with `@Deprecated(forRemoval = true)` before deletion.

## Variant Types

Use sealed interfaces + records (Java 17+) for sum types with exhaustive
`switch`:

```java
public sealed interface TaskStatus permits Pending, InProgress, Completed, Cancelled {}
public record Pending() implements TaskStatus {}
public record InProgress(String assignee, Instant startedAt) implements TaskStatus {}
public record Completed(Instant completedAt, String completedBy) implements TaskStatus {}
public record Cancelled(String reason, Instant cancelledAt) implements TaskStatus {}

public String label(TaskStatus s) {
    return switch (s) {
        case Pending p -> "Pending";
        case InProgress i -> "In progress (" + i.assignee() + ")";
        case Completed c -> "Done on " + c.completedAt();
        case Cancelled x -> "Cancelled: " + x.reason();
    };
}
```

## Input/Output Separation

Separate request records (caller-provided) from response records
(server-generated fields included). See `CreateTaskInput` vs `Task` in Contract
Definition above.

## Opaque IDs

Wrap IDs in record types so distinct IDs are not interchangeable:

```java
public record TaskId(String value) {}
public record UserId(String value) {}

Task getTask(TaskId id);
```
