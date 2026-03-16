/** input for storing a named secret value in Deno KV */
export interface SetSecretDto {
  secretKey: string;
  secretValue: string;
}
