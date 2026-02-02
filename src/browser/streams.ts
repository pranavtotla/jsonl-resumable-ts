export const toWebStream = <T>(iterable: AsyncIterable<T>): ReadableStream<T> => {
  const iterator = iterable[Symbol.asyncIterator]();

  return new ReadableStream<T>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value as T);
    },
    async cancel() {
      if (iterator.return) {
        await iterator.return();
      }
    },
  });
};
