---
title: "A simple fix to Civilization V's 'recapture capital' crash on 64-bit Mac"
description: "Civ V crashes deterministically on Mac whenever a civilization loses, then regains its original capital under certain conditions. I was frustrated by this, investigated, and built a fix."
publishedOn: 2026-09-15
draft: false
---

## The problem setup

- Civilization V on a 64-bit Mac (anything running macOS Catalina or later, so any Mac updated since 2019)
- Two AI civilizations (let's say the Iroquois and Japan) are at war. The Iroquois conquer Kyoto, the Japanese capital city. 
- On Japan's turn, they reconquer Kyoto.
- As this happens, the game crashes. This is repeatable and basically unavoidable - reloading from an autosave repeats the crash.
- You are now forced to give up on a save that may have been going for a hundred turns. :(

If you just want the fix, the script and instructions on how to download and run it is (here, link to section). Full code for what it does is (here).

## What was already known

There's a couple of places this is discussed on the internet. I've looked it up a few times in search of a fix. This is what I could find - there may be more I missed elsewhere:
- Details that the bug exists, some of them correctly pinning it to a civilization recapturing their capital (links)
- A common suggestion is to roll back a few turns and try to intervene to change the outcome of the war. (link) While this is a fun challenge, it can be very difficult/impossible in some situations (e.g. unmet AIs fighting on the other side of the world).
- An enterprising person made a Lua mod called Rebuild Original Capital (here, link), which avoids the crash by disbanding and re-founding the city just before it's recaptured, restoring its population and buildings. I only found this after I'd resolved the problem myself, but it's a pretty good solution. There are some downsides - recovering the capital via liberation or a peace deal still triggers the bug, and it can break some other game triggers and potentially conflict with other mods. But if I'd found this before resolving the bug I probably would have used this mod rather than dig into the problem more deeply to understand it and create the simpler, more general fix. 

I couldn't find anyone explaining *why* the crash happens. Me and my Claude looked into it, and thanks to some investigation, mostly done by my Claude, we found the problem, which pretty immediately implies the fix. Because we're directly fixing the bug that's the root cause, there are no negative side effects (that I'm aware of), and the game should play exactly as it did prior to the move to 64-bit. 

## Reading the crash log

macOS crash reports have a lot of info.


```
Exception Type:    EXC_BAD_ACCESS (SIGSEGV)
Exception Subtype: KERN_INVALID_ADDRESS at 0x00007f9359251f3f
VM Region Info: 0x7f9359251f3f is not in any region.
      Bytes after previous region: 2300911424
--->  GAP OF 0x652fdff000 BYTES
```
`KERN_INVALID_ADDRESS` is the error code for accessing an address where nothing is mapped at all. This is what actually causes the crash. In this case, the address that the process is trying to access is wildly outside where anything is stored. That's a pretty big red flag.


The crashing thread is in `libCvGameCoreDLL_Expansion2_DLL.dylib`, which is the game's rules engine. Further investigation is pretty much impossible unless we have access to the code of the game's rules engine. Fortunately, Firaxis released the full rules engine code (links) to help modders during development. Thanks Firaxis!

Disassembling at the faulting address gives a function four instructions long:

```
push rbp
mov  rbp, rsp
mov  eax, esi                          ; 32-bit move — zero-extends
mov  al, byte ptr [rdi + rax + 1848]   ; SIGSEGV
ret
```

This is not something I'm very familiar with, but my Claude and some further reading clarified it for me: it's a one-line memory accessor, telling the computer to read byte number `esi` from an array at offset 1848 inside an object. 
Rosetta (Apple's translation layer, which lets Intel-built apps like Civ V run on Apple Silicon Macs) leaves some extra scratch registers behind in the crash report. Those show us the address the game had computed just before it died, which is what tells us what went wrong. (On an Intel Mac you'd get the same crash, just without that extra info.) The interesting one is `esi`, which is `0xFFFFFFFF`.

Normally, an array index is something like '10', which returns whatever's stored 10 steps past where the array begins. `0xFFFFFFFF` is a very suspicious value - it's the maximum possible value in 32 bits, and when you see it in situations like this, it's often because someone passed -1 and it got interpreted as an unsigned int. 

## Which array

This took two steps, because the crash log and the source code don't speak the same language. The compiled game only knows about *offsets* — "read the byte 1848 steps into this object". The source code only knows about *names* — `m_abHasMet`, `m_abAtWar`, and so on. Neither one gives you both halves, so we had to build the bridge ourselves.

First, we scanned the whole compiled binary for every byte-array access shaped like `[base + index + N]`, and collected the values of N. Ten of them came back in a neat run, each one exactly 80 apart: 1768, 1848, 1928, and so on up to 2488. A run like that almost certainly means ten arrays of 80 entries each, sitting next to each other in memory.

Then we looked at the source. `CvTeam.h` declares exactly ten `bool` arrays, one after another in a single block. Ten arrays in the code, ten evenly spaced offsets in the binary — so they line up in order:

| offset | member |
|---|---|
| 1768 | `m_abHasFoundPlayersTerritory` |
| **1848** | **`m_abHasMet`** |
| 1928 | `m_abAtWar` |
| 2008 | `m_abPermanentWarPeace` |
| 2088 | `m_abEmbassy` |
| 2168 | `m_abOpenBorders` |
| 2248 | `m_abDefensivePact` |
| 2328 | `m_abResearchAgreement` |
| 2408 | `m_abTradeAgreement` |
| 2488 | `m_abForcePeace` |

Our crash was at offset 1848, which is the second in the run: `m_abHasMet`. (As a sanity check, the most-referenced array in the whole binary turns out to be the one that maps to `m_abAtWar` — which is exactly what you'd expect, since the game asks "are we at war with them?" constantly.) So the crash is happening in `CvTeam::isHasMet(-1)`.
We can now read the exact code of the function that's causing our crash:

```cpp
bool CvTeam::isHasMet(TeamTypes eIndex) const
{
    CvAssertMsg(eIndex >= 0, "eIndex is expected to be non-negative (invalid Index)");
    CvAssertMsg(eIndex < MAX_TEAMS, "eIndex is expected to be within maximum bounds (invalid Index)");
    return m_abHasMet[eIndex];
}
```

The developers are rightfully wary of a negative index, they have 2 asserts to check it. But asserts don't do anything in released code, so in the shipped game the negative index was passed into `isHasMet` and sailed straight through to the array and crashed our game.

## Which call site

`isHasMet` is called in lots of places in the rules engine. But the error logs give us enough information to figure out where it is, by logging the values of string constants that were in use at the time:

- **`CvUnit::setXY`** — `TXT_KEY_UNIT_CAPTURED`, `CanDisplaceCivilian`, `UnitSetXY`
- **`CvPlayer::acquireCity`** — `TXT_KEY_MISC_CAPTURED_CITY`, `Capture Gold 1`, spy-eviction-on-conquest
- **`CvPlayer::SetHasLostCapital`** — a wall of `TXT_KEY_NOTIFICATION_*_LOST_CAPITAL` and
  `*_REGAINED_CAPITAL`

So what happened is: 
- a Japanese unit moved onto Kyoto, recapturing it from the Iroquois.
- The game tries to send notifications that this has occurred
- While trying to send 'Player recovered capital' notifications, the game crashes.

## The bug

`SetHasLostCapital` handles a civ losing its capital, and a civ recapturing its capital. Crucially, they both try to compute which player is now in the 'lead' by holding the most capitals. Notably, sometimes there isn't a unique leader - when e.g. multiple players have the same number of original capitals. 

The two parts of the function do the same job and look like they were probably written by copying one to the other. Here is the half that works:

```cpp
else if (eWinningTeam != NO_TEAM)                                       // 1. is there a unique winner?
{
    if (GET_TEAM(GET_PLAYER(ePlayer).getTeam()).isHasMet(eWinningTeam)) // 2. have we met them?
    { ... }
}
```

And here is the half that doesn't:

```cpp
else if (GET_TEAM(getTeam()).isHasMet(eWinningTeam))   // 2. have we met them?  ← RUNS FIRST
{ ... }
else if (eWinningTeam != NO_TEAM)                      // 1. is there a winner?  ← TOO LATE!
{ ... }
```

In the working version the existence check gates the lookup. In
the broken one the lookup runs unconditionally. So if we're in the 'player regained capital' branch, then if `eWinningTeam` is `NO_TEAM` (i.e. there is no unique leading player), which has value `-1`, and we call `isHasMet` with `-1` and the game breaks. 

That's our bug! Anytime a civ recaptures their capital and there's no unique leading civ, the game tries to tell everyone, slips on a banana peel and crashes everything.

## Why Windows players have never seen this, and Mac players didn't until the 64-bit migration. 

The core rules engine is the same code for all versions of Civilization V. So what's up with the crash only appearing for 64-bit Mac users?

`TeamTypes` is a signed enum where `NO_TEAM = -1`. The array's subscript operator is declared
`T& operator[]( unsigned int i )`. 
Passing `-1` interprets the same 32 bits as `4294967295` - a signed int being interpreted as an unsigned int.
Had the parameter been `int`, the compiler would sign-extend and you'd read the byte *before* the array, which might be incorrect but wouldn't generally crash the game. But because it's unsigned, you read four gigabytes past it.

(We haven't validated this bit, but it's our best guess). Civ V on Windows is a 32-bit
binary. There, the address arithmetic happens in 32 bits and simply wraps. So adding `0xFFFFFFFF` to a 32-bit
value is the same as subtracting one. As a result, Windows lands on the byte immediately before `m_abHasMet`, reads
something meaningless, picks slightly wrong notification text, and carries on. Not a big deal.

Aspyr's Mac port was rebuilt as 64-bit for Catalina, which removed 32-bit support. And on 64-bit there's nothing to wrap around. On Windows, `base + 4294967295` wraps around the 32-bit boundary (counting up to the max and starting from zero again) and becomes `base - 1`. On 64-bit Mac, it's just telling the computer to look four gigabytes away from the rest of the game's memory addresses.

## The fix

We can't tweak the rules engine source code and rebuild the game from that, because the Mac version of Civilization V doesn't allow loading custom DLL mods. This is incidentally why Vox Populi and things like that aren't available on Mac. 
Fortunately, we don't need to do that. The required change is very small, so instead of fixing the code and rebuilding, we can subtly tweak the compiled code. 

The function is 15 bytes with one byte of padding after it, so there are exactly 16 bytes to work with.
A fixed version, that checks if the function has been passed a negative index, fits in exactly 16:

```
      31 c0                    xor  eax, eax            ; default: false
      85 f6                    test esi, esi
      78 09                    js   done                ; negative index -> return false
      89 f0                    mov  eax, esi
      8a 84 07 38 07 00 00     mov  al, [rdi+rax+1848]
done: c3                       ret
```

This actually has slightly *better* behaviour than the 'crash-free' Windows code. On Windows the 'capital regained' notification could be inaccurate if the array index pointed to random memory, it just wouldn't crash the game. Here we guarantee a correct notification. Not that that's super important compared to avoiding the crash, but it's nice.

This part I'm not going to claim I fully understand - machine code is pretty opaque to me, and I'm trusting my Claude + validation through successful testing and gameplay that this change does what we want. Some technical details on how we can adjust the function:

- The frame-pointer prologue can be cut to save space. It's a leaf function and doesn't need to be, which buys the four bytes for
the check. 
- The `ret` lands exactly on the old padding byte, so nothing after it moves. No relocation, no resizing, no change to the rest of the file.

In bytes, at the one location in the binary matching `55 48 89 e5 89 f0 8a 84 07 38 07 00 00 5d c3`
(and it is unique — exactly one match in the whole file):

```
before:  55 48 89 e5 89 f0 8a 84 07 38 07 00 00 5d c3 90
after:   31 c0 85 f6 78 09 89 f0 8a 84 07 38 07 00 00 c3
```

Nothing else changes in the entirety of the compiled code. 
Patching invalidates Aspyr's code signature, so the dylib needs re-signing — `codesign --force --sign -` is enough, because the app's main executable has no hardened runtime and no library validation, so an ad-hoc nested dylib is accepted.

I've tested this only on my machine, and thus far only on one save-file. With this patch applied, I got past the turn that previously always crashed and have managed to finish the game. 

## Limits

- **One save, one build.** Not gonna overclaim - if this breaks elsewhere, sorry about that.
- **It fixes this crash, not every Mac crash.** There are similar bugs elsewhere in the codebase that might be able to cause similar crashes. In order to keep this fix simple (and hopefully understandable), we've only fixed this specific one. It's also (as best I can recall) the only single-player consistent crash I've run into in several years of playing Civilization V.
- **Steam will revert it.** "Verify integrity of game files" restores the original, and so will any update. The upside is that if you're worried that this patch breaks something on your machine, it's very easy to remove. We have shipped an `--undo` mode on the patch in case you want a targeted revert though. 
- **Never install a patched binary from someone else.** Including mine. That can be quite dangerous. What we're distributing here isn't a new binary, it's instructions on how to make a very small change to an existing binary, along with explanations of what it should do. It's sixteen bytes and the whole thing fits in a paragraph. That said, if you're nervous about this process, that's fair. Hopefully others with knowledge can read the working above and confirm that it's a safe and reasonable thing to do.

## Checking our work

Everything above should be verifiable. The Firaxis SDK source is public. `objdump` will show you the function that causes the crash. The crash log arithmetic is four additions. If we've got something wrong, please let us know! 
