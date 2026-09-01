import { CLIENTS } from '../data/site'

// The client strip: a band of warm paper laid straight across the hero's film,
// with the client marks travelling through it. The track carries the list twice
// so translating it by exactly half its width loops seamlessly.
//
// CLIENTS entries fall back to their name set in the brand serif where no logo
// file exists yet — drop a file in /public and set `logo` to swap a name for a
// mark, without touching this component.
export default function LogoMarquee() {
  const run = [...CLIENTS, ...CLIENTS]
  return (
    <div className="relative w-full overflow-hidden bg-paper py-5 sm:py-7">
      <ul className="animate-marquee flex w-max items-center gap-16 sm:gap-24" aria-hidden="true">
        {run.map((client, i) => (
          <li key={`${client.name}-${i}`} className="shrink-0">
            {client.logo ? (
              <img
                src={client.logo}
                alt=""
                className="h-8 w-auto object-contain opacity-80 sm:h-10"
                loading="lazy"
              />
            ) : (
              <span className="whitespace-nowrap font-serif text-xl tracking-[0.08em] text-[#1a1c20]/80 sm:text-2xl">
                {client.name}
              </span>
            )}
          </li>
        ))}
      </ul>
      {/* The same list once, readable, for anything that is not watching. */}
      <ul className="sr-only">
        {CLIENTS.map((client) => (
          <li key={client.name}>{client.name}</li>
        ))}
      </ul>
    </div>
  )
}
