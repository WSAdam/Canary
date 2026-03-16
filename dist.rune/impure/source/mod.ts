import type { CheckDto } from "../../dto/check-dto.ts";
import type { ResponseDto } from "../../dto/response-dto.ts";
import { BaseSource } from "./shared/mod.ts";
import { Http } from "./implementations/http/mod.ts";

export class Source {
  private constructor(private readonly impl: BaseSource) {}

  static fromCheck(_dto: CheckDto): Source {
    // Currently HTTP is the only supported source type.
    return new Source(new Http());
  }

  async fetch(dto: CheckDto): Promise<ResponseDto> {
    return await this.impl.fetch(dto);
  }
}
