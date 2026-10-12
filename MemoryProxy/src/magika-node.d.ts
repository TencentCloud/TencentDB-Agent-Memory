declare module "magika/node" {
  export class MagikaNode {
    static create(options: {
      modelPath: string;
      modelConfigPath: string;
    }): Promise<unknown>;
  }
}
