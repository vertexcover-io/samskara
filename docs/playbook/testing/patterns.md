# Other test-writing patterns

The two workflows in this folder — blind-from-signatures and
coverage-driven — are the ones we run as documented processes. These are
the other patterns worth knowing. Each entry says what it is, when it
earns its cost, and what it needs from the project. When one of them
gets used enough to deserve steps, it graduates to its own doc here.

**Bug-first regression.** Every diagnosed failure ends with a test that
reproduces it, written before the fix and green after. The RCA already
did the expensive part — finding the exact state and input that break —
so the test is cheap at that moment and impossible to reconstruct later.
Needs: a habit hook at the end of the debugging workflow, and a place in
the registry for rows whose origin is an incident.

**Golden-master capture.** Record what a flow actually produces — the
task sequence, the persisted state, the emitted events — normalize the
volatile fields out, and diff future runs against the capture. It proves
"nothing changed", not "it's correct", which is exactly what a refactor
needs and exactly what new-feature work doesn't. In this repo the
verb-refactor-audit skill is this pattern, built.

**Property-based generation.** Where inputs have a typed, validated
shape (a DTO with ranges, an enum, a schema), generate many inputs and
assert properties that must hold for all of them — valid inputs never
500, invalid inputs always reject with the field named, round-trips
preserve the value. Strongest on validation layers and serialization;
weak where the interesting behavior needs seeded state per case. Needs:
a generator library in the test toolchain and machine-readable
constraints.

**Parity (differential) testing.** Two implementations that promise the
same surface — a stub and its real twin, a mock driver and the vendor
one, an old path and its refactor — run against the same inputs, and
the test asserts they agree on signatures and observable behavior. Drift
between twins is otherwise invisible until a user hits it. This repo's
stub-vs-SDK conformance checks are the static half; running the same
call through both modes is the dynamic half.

**Mutation-checked assertions.** After tests exist, deliberately break
the code — flip a comparison, drop a call — and confirm a test goes
red. A suite that stays green under mutation has weak assertions, and
this is the only direct measure of that. Expensive to run broadly;
cheapest as a spot check on a suite you're about to trust for a
refactor, or on tests an agent just wrote in bulk.

**Doc-driven checks.** Walk a maintained flow document (here: a
breadcrumb) and turn each claimed step into an assertion — the request
hits this endpoint, this row appears, this socket event fires. It tests
the system and the document at once: a red check means either the code
or the map is wrong, and both outcomes are worth having. Needs: flow
docs that are actually maintained, otherwise it just automates staleness
alarms.

**Failure-injection journeys.** Run a normal journey and break one
dependency mid-flight — kill a service, time out a device call, drop the
socket — then assert the system does what its error handling promises:
the run aborts with a message naming the cause, the lock releases, the
bill doesn't accrue. Happy-path suites never touch this, and it's where
production incidents live. Costs harness work (a way to break things on
cue) and is worth it only on the flows where a bad failure strands state.

**Adversarial pairing.** One agent writes or changes code; a second
agent, given only the contract, tries to write a failing test against
it. This is blind signature testing sharpened into a duel — the second
agent is rewarded for red, not green, which counters the universal drift
of test writers toward passing tests. Cheap to try on any PR that adds a
surface; needs nothing but the discipline to keep the two contexts
separate.
