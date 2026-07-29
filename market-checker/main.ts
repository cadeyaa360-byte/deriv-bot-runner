// Learn more: https://docs.val.town/vals/http/
export default async function (req: Request): Promise<Response> {
  return Response.json({ ok: true })
}