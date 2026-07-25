---
paths:
  - "**/*.pl"
  - "**/*.pm"
  - "**/*.t"
  - "**/*.psgi"
  - "**/*.cgi"
---
# Perl Patterns

> This file extends common/patterns.md (../common/patterns.md) with Perl-specific content.

## Repository Pattern

Use **DBI** or **DBIx::Class** behind an interface:

```perl
package MyApp::Repo::User;
use Moo;

has dbh => (is => 'ro', required => 1);

sub find_by_id ($self, $id) {
    my $sth = $self->dbh->prepare('SELECT * FROM users WHERE id = ?');
    $sth->execute($id);
    return $sth->fetchrow_hashref;
}
```

## DTOs / Value Objects

Use **Moo** classes with **Types::Standard** (equivalent to Python dataclasses):

```perl
package MyApp::DTO::User;
use Moo;
use Types::Standard qw(Str Int);

has name  => (is => 'ro', isa => Str, required => 1);
has email => (is => 'ro', isa => Str, required => 1);
has age   => (is => 'ro', isa => Int);
```

## Resource Management

- Always use **three-arg open** with `autodie`
- Use **Path::Tiny** for file operations

```perl
use autodie;
use Path::Tiny;

my $content = path('config.json')->slurp_utf8;
```

## Module Interface

Use `Exporter 'import'` with `@EXPORT_OK` — never `@EXPORT`:

```perl
use Exporter 'import';
our @EXPORT_OK = qw(parse_config validate_input);
```

## Dependency Management

Use **cpanfile** + **carton** for reproducible installs:

```bash
carton install
carton exec prove -lr t/
```

## Contract Definition

Use Moose roles for contracts and Moose classes for DTOs:

```perl
package TaskAPI {
    use Moose::Role;
    requires 'create_task';
    requires 'list_tasks';
    requires 'get_task';
    requires 'update_task';
    requires 'delete_task';
}

package CreateTaskInput {
    use Moose;
    has title       => (is => 'ro', isa => 'Str', required => 1);
    has description => (is => 'ro', isa => 'Maybe[Str]');
    __PACKAGE__->meta->make_immutable;
}
```

## Error Representation

Use exception objects (e.g. `Throwable`); map to the universal REST envelope
(`{ code, message, details? }`) in framework exception handlers (PSGI
middleware, Dancer/Dancer2 error mappers):

```perl
package ApiError {
    use Moose;
    with 'Throwable';
    has code    => (is => 'ro', isa => 'Str', required => 1);
    has message => (is => 'ro', isa => 'Str', required => 1);
}

package ValidationError {
    use Moose;
    extends 'ApiError';
    has '+code' => (default => 'VALIDATION_ERROR');
    has details => (is => 'ro', isa => 'ArrayRef[HashRef]');
}
```

## Boundary Validation

Validate at the controller boundary with `Params::ValidationCompiler` or
`Data::Validator`; internal code trusts the parsed hash:

```perl
use Params::ValidationCompiler qw(validation_for);

my $check_input = validation_for(
    params => {
        title       => { optional => 0 },
        description => { optional => 1 },
    },
);

sub create {
    my ($class, $args) = @_;
    my $valid = $check_input->($args);  # throws on invalid
    return $svc->create($valid);
}
```

## Additive Evolution

- Add new Moose attributes as optional (`required => 0` or with `default`) so
  existing callers keep working.
- Adding a required attribute is breaking.
- For JSON DTOs, decode permissively (ignore unknown keys); tighten only in a
  dedicated validation layer.
- Mark removals with a deprecation comment + release notes before deletion.

## Variant Types

Perl has no native sum types. Model variants as objects + `given`/`when` (or
`match::simple`), one class per variant:

```perl
package TaskStatus::Pending    { use Moose; __PACKAGE__->meta->make_immutable }
package TaskStatus::InProgress { use Moose; has [qw(assignee started_at)] => (is => 'ro', required => 1); __PACKAGE__->meta->make_immutable }
package TaskStatus::Completed  { use Moose; has [qw(completed_at completed_by)] => (is => 'ro', required => 1); __PACKAGE__->meta->make_immutable }
package TaskStatus::Cancelled  { use Moose; has [qw(reason cancelled_at)] => (is => 'ro', required => 1); __PACKAGE__->meta->make_immutable }

sub label {
    my ($s) = @_;
    return 'Pending'             if $s->isa('TaskStatus::Pending');
    return "In progress ($s->{assignee})" if $s->isa('TaskStatus::InProgress');
    return 'Done'                if $s->isa('TaskStatus::Completed');
    return "Cancelled: $s->{reason}"      if $s->isa('TaskStatus::Cancelled');
}
```

## Input/Output Separation

Separate request DTOs (caller-provided) from response DTOs (server-generated
fields included). Use distinct Moose classes for each.

## Opaque IDs

Use Moose subtypes or small immutable value classes to distinguish IDs:

```perl
use Moose::Util::TypeConstraints;
subtype TaskId => as Str;
subtype UserId => as Str;

sub get_task { my ($self, $id) = @_; ... }
```
