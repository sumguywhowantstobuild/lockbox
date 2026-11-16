// Task 2's carried item R2: a finishing job moves focus only when its own card had it. Two jobs can run side by side (a batch in one vault and
// a copy in another), and one ending must not take focus out of the other's Cancel.
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { takeJobFocus } from "./focus";

afterEach(() => {
  cleanup();
});

/** The page with the cards of the jobs in `running`, and the message stack a result lands in. */
function Page({ running }: { running: readonly number[] }) {
  return (
    <>
      {running.includes(1) ? (
        <section className="job" data-operation="1" aria-label="First job">
          <button type="button">Cancel the first</button>
        </section>
      ) : null}
      {running.includes(2) ? (
        <section className="job" data-operation="2" aria-label="Second job">
          <button type="button">Cancel the second</button>
        </section>
      ) : null}
      <div className="tstack">
        <button type="button" className="tb2">
          Got it
        </button>
      </div>
    </>
  );
}

const turn = () => new Promise((done) => window.setTimeout(done, 5));

test("one_jobs_end_leaves_focus_in_another_jobs_card", async () => {
  const { rerender, getByRole } = render(<Page running={[1, 2]} />);
  const first = getByRole("button", { name: "Cancel the first" });
  first.focus();
  // The second job ends (its card goes) while focus is on the first job's Cancel.
  const refocus = takeJobFocus(2);
  rerender(<Page running={[1]} />);
  refocus();
  await turn();
  expect(document.activeElement).toBe(first);
});

test("a_jobs_own_end_moves_focus_to_the_result_message", async () => {
  const { rerender, getByRole } = render(<Page running={[1, 2]} />);
  getByRole("button", { name: "Cancel the first" }).focus();
  const refocus = takeJobFocus(1);
  rerender(<Page running={[2]} />);
  refocus();
  await turn();
  expect(document.activeElement).toBe(getByRole("button", { name: "Got it" }));
});

test("a_job_with_no_card_of_its_own_moves_nothing", async () => {
  const { getByRole } = render(<Page running={[1, 2]} />);
  const second = getByRole("button", { name: "Cancel the second" });
  second.focus();
  // A job the page never drew a bar for (Open, Replace file) has no operation to match.
  const refocus = takeJobFocus(null);
  refocus();
  await turn();
  expect(document.activeElement).toBe(second);
});

test("a_card_inside_the_add_panel_leaves_focus_to_the_panel", async () => {
  const { getByRole } = render(
    <aside className="panel">
      <section className="job" data-operation="5">
        <button type="button">Cancel</button>
      </section>
    </aside>,
  );
  getByRole("button", { name: "Cancel" }).focus();
  // The panel's own result takes focus (its heading), so the part that goes to the message does not run and race it.
  const refocus = takeJobFocus(5);
  refocus();
  await turn();
  expect(document.activeElement).toBe(getByRole("button", { name: "Cancel" }));
});
