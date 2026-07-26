import assert from "node:assert/strict";
import test from "node:test";

import { sanitisePoll } from "../src/polls.js";

test("poll responses expose counts without voter identities", () => {
  const output = sanitisePoll(
    {
      id: "poll",
      author_id: "author",
      channel_id: "channel",
      server_id: "server",
      question: "Question?",
      multiple: false,
      closes_at: null,
      created_at: new Date("2026-01-01T00:00:00Z"),
      options: [
        { id: "one", label: "One", votes: ["me", "other"] },
        { id: "two", label: "Two", votes: [] },
      ],
    },
    "me",
  );

  assert.equal(output.options[0].votes, 2);
  assert.equal(output.options[0].selected, true);
  assert.equal("user_ids" in output.options[0], false);
});
