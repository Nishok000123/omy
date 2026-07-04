const messageIds = Array.from({length: 10}, (_, i) => i + 1);

const ctx = {
  chat: { id: 123 },
  telegram: {
    deleteMessage: async (chatId, msgId) => {
      // Simulate network delay
      return new Promise(resolve => setTimeout(resolve, 50));
    }
  }
};

async function originalDeletion(ctx, messageIds) {
  const start = Date.now();
  for (const msgId of messageIds) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, msgId);
    } catch (e) {
    }
  }
  const end = Date.now();
  console.log(`Original deletion took: ${end - start}ms`);
}

async function optimizedDeletion(ctx, messageIds) {
  const start = Date.now();
  await Promise.allSettled(
    messageIds.map(msgId => ctx.telegram.deleteMessage(ctx.chat.id, msgId))
  );
  const end = Date.now();
  console.log(`Optimized deletion took: ${end - start}ms`);
}

async function run() {
  await originalDeletion(ctx, messageIds);
  await optimizedDeletion(ctx, messageIds);
}

run();
