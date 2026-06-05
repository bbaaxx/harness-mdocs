import { createOpencodeAdapter } from './adapter';
import { wrapOpencodeToolResults } from './result';

export { createOpencodeAdapter };

export default (async ({ directory }: { client: any; project: any; directory: string }) => {
  return wrapOpencodeToolResults(createOpencodeAdapter(directory));
}) satisfies any;
