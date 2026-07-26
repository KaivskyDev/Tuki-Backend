export function sanitisePoll(poll, userId) {
  return {
    id: poll.id,
    author_id: poll.author_id,
    channel_id: poll.channel_id,
    server_id: poll.server_id,
    question: poll.question,
    multiple: poll.multiple,
    closes_at: poll.closes_at,
    created_at: poll.created_at,
    options: poll.options.map((option) => ({
      id: option.id,
      label: option.label,
      votes: option.votes.length,
      selected: option.votes.includes(userId),
    })),
  };
}
