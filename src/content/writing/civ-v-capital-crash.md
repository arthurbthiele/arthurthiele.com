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

If you just want the fix, the script and step-by-step instructions are [here](https://github.com/arthurbthiele/civ5-capital-crash-fix#just-fix-it). The full code is [here](https://github.com/arthurbthiele/civ5-capital-crash-fix/blob/main/fix-civ5-capital-crash.sh). It's pretty short.

If you want MORE than just the fix, and want to follow me on a journey as I learn how to read crash reports, write some basic Assembly, and how CPU registers work, then the following is a transcript of my first time doing basically any of those things. I was guided through all of this by my trusty pal Claude Opus 5, who initially found and patched the bug, then diligently talked me through the concepts below, for which I'm very grateful. If there are errors, they're probably mine - please let me know at arthurbthiele at gmail.com. Claude has a note of its own on how the whole thing went.[^claudenote] Apart from that note, everything else here is in my own words.

## What was already known

There's a couple of places this is discussed on the internet. I've looked it up a few times in search of a fix. This is what I could find - there may be more I missed elsewhere:
- Details that the bug exists, some of them correctly pinning it to a civilization recapturing their capital ([Steam](https://steamcommunity.com/app/8930/discussions/1/3048357185560564326/), [CivFanatics](https://forums.civfanatics.com/threads/civ-v-mac-crashes-same-turn.671049/), [Civ5 wiki](https://civilization.fandom.com/wiki/Bugs_(Civ5)))
- A common suggestion is to [roll back a few turns](https://steamcommunity.com/app/8930/discussions/1/3412055301107710969/) and try to intervene to change the outcome of the war. While this is a fun challenge, it can be very difficult/impossible in some situations (e.g. unmet AIs fighting on the other side of the world).
- An enterprising person made a Lua mod called [Rebuild Original Capital](https://forums.civfanatics.com/threads/mod-rebuild-original-capital-crash-bug-workaround-for-mac.690850/), which avoids the crash by disbanding and re-founding the city just before it's recaptured, restoring its population and buildings. I only found this after I'd resolved the problem myself, but it's a pretty good solution. There are some downsides - recovering the capital via liberation or a peace deal still triggers the bug, and it can break some other game triggers and potentially conflict with other mods. But if I'd found this before resolving the bug I probably would have used this mod rather than dig into the problem more deeply to understand it and create the simpler, more general fix. 

I couldn't find anyone explaining *why* the crash happens. Me and my Claude looked into it, and thanks to some investigation, mostly done by my Claude, we found the problem, which pretty immediately implies the fix. Because we're directly fixing the bug that's the root cause, there are no negative side effects (that I'm aware of), and the game should play exactly as it did prior to the move to 64-bit. 

## Reading the crash log

macOS crash reports have a lot of info. This is the big 'everything broke' part of the [crash report](/civ-v-crash-report.html) I got from this bug:


```
Exception Type:    EXC_BAD_ACCESS (SIGSEGV)
Exception Subtype: KERN_INVALID_ADDRESS at 0x00007f9359251f3f
VM Region Info: 0x7f9359251f3f is not in any region.
      Bytes after previous region: 2300911424
--->  GAP OF 0x652fdff000 BYTES
```
`KERN_INVALID_ADDRESS` is the error code for accessing a memory address where nothing is mapped at all. This is what actually causes the crash. In this case, the address that the process is trying to access is *wildly* far away from anything else being stored (~2 GB away from the nearest legitimate address). That's a pretty big red flag.

We can see what caused this by checking the stack trace in the crash report:

```
Thread 4 Crashed:: WinMain (WinID 2)
0   ???                                     0x1304c24d0 ???
1   libCvGameCoreDLL_Expansion2_DLL.dylib   0x12f677000 + 3013620
2   libCvGameCoreDLL_Expansion2_DLL.dylib   0x12f677000 + 2995429
```


The crashing thread is in `libCvGameCoreDLL_Expansion2_DLL.dylib`, which is the game's rules engine. That doesn't tell us much unless we have access to the code of the game's rules engine. Fortunately, if you own the game on Steam, Firaxis also gives you access to the full rules engine code in the official Civilization V SDK, probably to help with modding.[^sdk] Thanks Firaxis!

The numbers `0x12f677000 + 3013620` are load address (i.e. where the dylib library was loaded into memory by the operating system) and the offset (how far into that allocated memory we are). The load address is randomised every time you start the program, but at any given time, if the program is doing the same thing, then the offset is a fixed position inside the relevant file, which is the game's code. 

Unfortunately, because we're not running the original Intel instructions, we can't simply use this to figure out which code was running when we crashed. The `0 ???` line above is where we'd want to find the relevant offset, but because Rosetta is translating the game's code to run on Apple Silicon, Rosetta has translated the Intel instructions into ARM ones that can run directly on the Apple CPU.

To recover what would have been next to `0 ???`, we can look at the values in the CPU registers at the time of the crash, one of which always holds the address of the instruction being executed - `rip`:
```
Thread 4 crashed with X86 Thread State (64-bit):
  ...
  rip: 0x000000012fa52896  rfl: 0x0000000000000202
```

By the way, the crash report notices the discrepancy between the `Thread 4 Crashed` log from earlier and the `rip` register - see here:
```
Error Formulating Crash Report:
RIP register does not match crashing frame (0x12FA52896 vs 0x1304C24D0)
```

Then, we can figure out what's happening there with a single command on macOS.[^startaddress]

```
objdump -d --start-address=0x3db890 --stop-address=0x3db89f \
  --x86-asm-syntax=intel "…/libCvGameCoreDLL_Expansion2_DLL.dylib"
```

This tells us the exact assembly code that was running at the time of the crash:
```asm
push rbp
mov  rbp, rsp
mov  eax, esi
mov  al, byte ptr [rdi + rax + 1848]
pop  rbp
ret
```

To start with, let's do a side quest to learn a little about CPU registers. 

Unlike memory, which has an address and represents most places data can be stored on a computer, a CPU has a fixed, small number of registers, each of which holds (on most modern devices) 64 bits (8 bytes). There are sixteen general-purpose ones[^registers] — and all are named. They're also the only place any actual calculations can be done - a value needs to be moved from memory into a register in order for the CPU to operate on it in any way[^loadstore].

Along with `rip` that we mentioned earlier, there are a few more register names and assembly instructions that we should learn before reading this function:

| register | what it holds |
|---|---|
| `rbp` | The name comes from 'r[^rprefix] base pointer'. Variables assigned during a function's flow live in the stack, and when a function calls into another function, we leave the earlier parts of the stack intact and start on our own section of the stack, called the 'stack frame'. `rbp` points to the start of this function's section of the stack.[^stackdirection] |
| `rsp` | Named for being the 'stack pointer' - it's the current top of the stack (i.e. the lowest memory value that's currently live in the stack). This automatically adjusts whenever anything is pushed to, or popped from, the stack.|
| `rdi` | By convention, this holds a function's first argument. |
| `rsi` | By convention, this holds a function's second argument. |
| `rax` | A 'scratch' register that can be used for whatever, but by convention it's often used to store a function's return value. |

| instruction | what it does |
|---|---|
| `push` | Accepts a register and writes its contents to the stack. |
| `mov` | Copies the second thing into the first. Either side can be a register, and one side can be a location in memory. |
| `pop` | Takes whatever's on top of the stack (recall - this is the *lowest* memory value on the stack) and writes it to the supplied register. |
| `ret` | The counterpart to `call`. It takes the return address off the top of the stack and jumps there, handing control back to whoever called us. |

Every one of these registers can be read and written at four different sizes, and they are all the same physical register. For `rax` those are `rax` (all 64 bits), `eax` (the low 32), `ax` (the low 16) and `al` (the low 8). `rsi` works the same way, as `rsi` / `esi` / `si` / `sil`.

Writing to the **32-bit** name doesn't just change the bottom half — it also sets the top half to zero.[^zeroing] Writing to the 8-bit or 16-bit name leaves the rest of the register alone. This will turn out to be an important part of why the bug happens.

Here's an example of what the relevant section of the stack might look like after line 2 of our function. We can see 2 stack frames - white memory addresses from the previous, calling function, and orange memory addresses at `0x7018` and `0x7010` which is the whole region of the stack allocated to the function that actually crashed - only 2 slots, 16 bytes in total, not a lot!

![The stack immediately after `mov rbp, rsp`. The caller's frame sits above; our own two slots hold the return address and the saved caller frame pointer, with `rbp` and `rsp` both landing on the same slot.](/diagrams/stack-frame.svg)

Now we're equipped to walk through the crashing function:

```asm
push rbp
mov  rbp, rsp
mov  eax, esi
mov  al, byte ptr [rdi + rax + 1848]
pop  rbp
ret
```

Line 1: `push rbp`

This saves the value of the `rbp` register to the stack. This is a standard thing to do at the start of a function, since we're starting a new stack frame, and the `rbp` register should now track *our* function's stack frame base - but the previous one's needs to be saved somewhere.
When we later return to the calling function, it needs to be able to know where its stored variables start, so it needs to know the address of the start of its stack frame.

This also has the nice consequence that we can trace back which functions called us if something goes wrong (hence the term 'stack trace'). 

Line 2: `mov  rbp, rsp`

This overwrites the `rbp` register with `rsp`, persisting the current address of the 'top of the stack' (the address we just pushed) in the `rbp` register, to record that it's now considered the base of our stack frame. 

This is where we would normally allocate space/memory addresses for our local variables with a line like `sub rsp, 776`, which would put the end of our stack frame 776 bytes further down to reserve that space - but this function has no local variables, so that doesn't happen here. This is why in our crash report, `rbp` and `rsp` have the same value - we're not actually reserving *any* space on the stack for this function (outside of boilerplate) so the base and top of the stack frame are the same pointer. 

Line 3: `mov eax, esi`

This copies the low 32 bits of the second argument of the function to the scratch register `eax`. Notably, because of the `e` at the start (not `r`), this *also* zeroes the high 32 bits of the receiving register `rax`. If the alternate instruction `movsxd` had been used, we would have written the high 32 bits as ones instead.

Line 4: `mov  al, byte ptr [rdi + rax + 1848]`

This is where things get interesting. 

This line says to compute the value of `rdi + rax + 1848`, then fetch one byte from that memory address (that's what `byte ptr` does), then write this to the low 8 bits of the `rax` register. And here is where we crash! We can see by the dumped register values that `rdi + rax + 1848` evaluates as `0x7F9259251808 + 0xFFFFFFFF + 1848 = 0x7F9359251F3F`, which is the unmapped address we tried to access that started us on this journey.

For completeness - Line 5: `pop  rbp`

This is boilerplate - reading the value from the top of the stack (`rsp`), saving it to the `rbp` register, and automatically adding 8 to the `rsp` register to reflect that we've taken something off the top of the stack. 

Line 6: `ret`

We don't need to return a value the way we might in another language (`return foo` in JS for example). By convention, we can just leave it in a CPU register where the calling function can grab it. So all this needs to do is pop the return address, which points to the specific point in code we need to pick up at the calling function now that this function has finished, and jumps us back into that function. Often, the calling function will follow up on this with an instruction by reading/using the value stored at the `rax` register (or in this case the low bits at `al`).


So! Where does this leave us? Well, we now know that:

a. the function that crashed asked us to go to a memory address of the form `base + index + 1848`

b. that we crashed because our function was passed `0xFFFFFFFF` as an input.

Normally, an array index is something like '10', which returns whatever's stored 10 steps past where the array begins. `0xFFFFFFFF` is a very suspicious value - it's the maximum possible value in 32 bits, and when you see it in situations like this, it's often because someone passed -1 and it got interpreted as an unsigned int. 

## Which function crashed?

We've been looking at the assembly code that crashed - the compiled function. To understand why it's happening, we want to figure out which function in the source code it is.

The compiled game logic (in Assembly) only knows about *offsets* — "read the byte 1848 steps into this object". The source code only knows about *names* of things — `m_abHasMet`, `m_abAtWar`, and so on. Neither one gives you both halves, so we had to build the bridge ourselves.

First, we scanned the whole compiled binary for every byte-array access shaped like `[base + index + N]`, and collected the values of N. Ten of them came back in a neat run, each one exactly 80 apart: 1768, 1848, 1928, and so on up to 2488. A run like that almost certainly means ten arrays of 80 entries each, sitting next to each other in memory.

Then we looked at the source. `CvTeam.h` declares exactly ten `bool` arrays, one after another in a single block. Each team gets their own instance of the array, which records which teams it has met. For example, to check if Japan has met Team 3, the program would check index 3 of Japan's `m_abHasMet` array, see if it's true or false, and act accordingly.
So we have ten arrays in the code, ten evenly spaced offsets in the binary (with a gap of 80 - there's room for 80 teams in this array - though a game with that many players is impossible, since `MAX_MAJOR_CIVS` is 22):

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

Our crash was at offset 1848, which is the second in the run: `m_abHasMet`. 

As a sanity check, we can see if the most-referenced array in the compiled code maps to an array we'd expect to be read often. The most-referenced array in the whole binary turns out to be the one that maps to `m_abAtWar` — which is exactly what you'd expect, since the game asks "are we at war with them?" constantly.

So the crash is happening when the game calls `CvTeam::isHasMet` with the argument `0xFFFFFFFF`[^argwidth], which is probably intended to represent an input of `-1`.

We can now read the exact code of the function that's causing our crash:
```cpp
bool CvTeam::isHasMet(TeamTypes eIndex) const
{
    CvAssertMsg(eIndex >= 0, "eIndex is expected to be non-negative (invalid Index)");
    CvAssertMsg(eIndex < MAX_TEAMS, "eIndex is expected to be within maximum bounds (invalid Index)");
    return m_abHasMet[eIndex];
}
```

The developers are rightfully wary of a negative index breaking things, they have 2 asserts to check it. But in this language (C++), asserts don't do anything in released code, so in the shipped game the negative index was passed into `isHasMet` and sailed straight through to the array and crashed our game.

## Which call site

`isHasMet` is called in lots of places in the rules engine. But the error logs give us enough information to figure out where it is, by noticing the text keys in the compiled code (which do survive as literal text), and cross-referencing that with the source code to see where those strings are used.

- **`CvUnit::setXY`** — `TXT_KEY_UNIT_CAPTURED`, `CanDisplaceCivilian`, `UnitSetXY`
- **`CvPlayer::acquireCity`** — `TXT_KEY_MISC_CAPTURED_CITY`, `Capture Gold 1`, spy-eviction-on-conquest
- **`CvPlayer::SetHasLostCapital`** — a wall of `TXT_KEY_NOTIFICATION_*_LOST_CAPITAL` and
  `*_REGAINED_CAPITAL`

So a unit was captured, a player lost a capital, and a player regained a capital. Looks like what happened is: 
- a Japanese unit moved onto Kyoto, recapturing it from the Iroquois.
- The game tries to send notifications that this has occurred
- While trying to send 'Player recovered capital' notifications in the `SetHasLostCapital` function, the game crashes.


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
the broken one the lookup runs unconditionally. So if we're in the 'player regained capital' branch, then if `eWinningTeam` is `NO_TEAM` (i.e. there is no unique leading player), which has value `-1`, we call `isHasMet` with `-1` and the game breaks. 

That's our bug! Anytime a civ recaptures their capital and there's no unique leading civ, the game tries to tell everyone, slips on a banana peel and crashes everything.

## Why this doesn't break for everyone

The core rules engine is the same code for all versions of Civilization V. So what's up with the crash only appearing for 64-bit Mac users?

`TeamTypes` is a signed enum where `NO_TEAM = -1`. The array's subscript operator is declared
`T& operator[]( unsigned int i )`. 
Passing `-1` interprets the same 32 bits as `4294967295` - a signed int being interpreted as an unsigned int.
Had the parameter been `int`, the compiler would sign-extend and you'd read the byte *before* the array, which might be incorrect but wouldn't generally crash the game. But because it's unsigned, you read four gigabytes past it.

Civ V on Windows is a 32-bit binary. There, the address arithmetic happens in 32 bits and simply wraps, because 'arithmetic in 32 bits' means taking modulo 2^32. So adding `0xFFFFFFFF` to a 32-bit
value is the same as subtracting one. As a result, Windows lands on the byte immediately *before* `m_abHasMet`, reads
something meaningless, picks slightly wrong notification text, and carries on. Not a big deal.

Aspyr's Mac port was rebuilt as 64-bit for Catalina, which removed 32-bit support. And on 64-bit there's nothing to wrap around, since `0xFFFFFFFF` = 2^32 - 1 isn't even close to where 64-bit maths would wrap, at 2^64. 

## The fix

We can't tweak the rules engine source code and rebuild the game from that, because the Mac version of Civilization V doesn't allow loading custom DLL mods. This is incidentally why Vox Populi and things like that aren't available on Mac. 
Fortunately, we don't need to do that. The required change is very small, so instead of fixing the code and rebuilding, we can subtly tweak the compiled code. 

The breaking function is 15 bytes with one byte of padding after it, so there are exactly 16 bytes to work with.
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

In bytes, at the one location in the binary matching `55 48 89 e5 89 f0 8a 84 07 38 07 00 00 5d c3`
(and it is unique — exactly one match in the whole file):

<div class="ba">
<div><h4>before</h4><pre><code>55 48 89 e5 89 f0 8a 84
07 38 07 00 00 5d c3 90</code></pre></div>
<div><h4>after</h4><pre><code>31 c0 85 f6 78 09 89 f0
8a 84 07 38 07 00 00 c3</code></pre></div>
</div>

Which disassembles to:

<div class="ba">
<div><h4>before</h4><pre class="numbered"><code><span>push rbp</span>
<span>mov  rbp, rsp</span>
<span>mov  eax, esi</span>
<span>mov  al, [rdi+rax+1848]</span>
<span>pop  rbp</span>
<span>ret</span>
<span>(one byte of padding)</span></code></pre></div>
<div><h4>after</h4><pre class="numbered"><code><span>xor  eax, eax</span>
<span>test esi, esi</span>
<span>js   done</span>
<span>mov  eax, esi</span>
<span>mov  al, [rdi+rax+1848]</span>
<span>done: ret</span></code></pre></div>
</div>

This is everything we need to do! It's a bit opaque, so let's talk it through briefly. We discussed what the left hand side does earlier, so let's just go through the replacement function on the right.

First off - the pieces of the original function we cut (its lines 1, 2 and 5) are boilerplate that don't need to exist on a leaf function (one that doesn't call any other functions). The last byte `90` of the original function is unreachable, since it's after `ret`, and `90` is the Assembly instruction for 'do nothing' - it's a padding instruction, so our function fits neatly into 16 bytes, and so we can safely remove it as well. That gives us some room to add in a check for if we're in the buggy scenario.

Line 1: `xor  eax, eax`

This zeroes `eax`. XOR gives 0 whenever two bits match, so a value XOR'd with itself is always zero - it's the standard way to clear a register, and it's shorter than writing `mov eax, 0`. We're doing it so that `al` (the low 8 bits, where our answer goes) is zero, i.e. 'false'. All will be revealed later.

Line 2: `test esi, esi`

`test` accepts 2 arguments and bitwise ANDs them, but throws the result away. That sounds pointless, except that when certain operations are done on registers, the CPU also records some facts about the result in a special register called the flags register[^flags]. ANDing a value with itself gives you the value back, so the flags now describe `esi` itself - including whether it's negative.

Line 3: `js   done`

`js` is an instruction that checks one specific bit of the flags register - the 'sign flag', which is a copy of the top bit of the last result - and if it's a 1, jumps to the `done` label. (Yes, assembly has GOTOs. In fact *all* control flow down here is GOTOs - every `if`, `while` and function call in the source becomes some kind of jump.)

The point of this is that our flags register is now based on `esi`, which holds the second argument. And `esi`'s top bit is *different* to `rsi`'s top bit: `rsi` holds `0x00000000FFFFFFFF`, whose top bit is a 0, but `esi` is only the bottom 32 bits, `0xFFFFFFFF`, whose top bit is a 1 - because of all the Fs. In most computer systems, a top bit of 1 means the number should be interpreted as negative.[^twoscomplement]

This is the whole reason the check works, and it only works because we test at 32 bits. Had we written `test rsi, rsi` instead, we'd have tested bit 63, found a zero, and proceeded to hit the bug.

Lines 4 and 5: unchanged from the original. The difference is that by the time we reach them, we know the index isn't negative, so we can't be in the buggy regime anymore.

Line 6: `done: ret`

`done` is just an anchor that line 3 can jump to - it's a name for an address, and it assembles to nothing at all. The jump doesn't actually store the address, either: `js done` assembles to the two bytes `78 09`, meaning 'if the sign flag is set, skip 9 bytes forward from here', which gets us to the `done`. That it's 9 bytes ahead is calculated during compilation.

Nothing else changes in the entirety of the compiled code. 
Patching invalidates Aspyr's code signature, so the dylib needs re-signing[^codesigning] — `codesign --force --sign -` is enough, because the app's main executable has no hardened runtime and no library validation, so an ad-hoc nested dylib is accepted.

Since building this fix, I've played through ~10 full games, and successfully finished 2 games that would otherwise have been unfinishable due to the bug. There seem to be no obvious crashes, and the patched game seems stable and safe to me. However:

## Limits

- **I've only tested this on my machine**. If this causes issues on your machine, or you think it will, please raise a Github issue.
- **It fixes this crash, not every Mac crash.** There are similar bugs elsewhere in the codebase that can cause similar crashes. In fact, I ran into one of those in a later game (which I believe was caused by a similar bug when freeing city-states, and was fixable in a similar way). In order to keep this fix simple (and hopefully understandable), this patch only fixes the one, most common bug.
- **Steam will revert it.** "Verify integrity of game files" restores the original, and so will any update. The upside is that if you're worried that this patch breaks something on your machine, it's very easy to remove. There's also an `--undo` mode on the patch in case you want a targeted revert. 
- **Patched binaries can be dangerous, and you should be wary of anyone trying to persuade you to use one.** Including me. This isn't a new binary, it's instructions on how to make a very small change to an existing binary, along with explanations of what it should do. It's sixteen bytes, and the whole thing fits in a paragraph. That said, if you're nervous about this process, there's not much I can say other than 'that's fair'. Hopefully others with knowledge can read the patch (and the reasoning above) and confirm that it's a safe and reasonable thing to do.

## Checking our work

Everything above should be verifiable. The Firaxis SDK source is public, and my crash log is attached [here](/civ-v-crash-report.html). `objdump` will show you the function that causes the crash. The crash log arithmetic is basically just four additions. If we've got something wrong, please let us know!

[^registers]: Sixteen general-purpose registers on a 64-bit Intel chip: `rax`, `rbx`, `rcx`, `rdx`, `rsi`, `rdi`, `rbp`, `rsp`, and `r8` through `r15`. There are a few more that can't hold ordinary data — `rip` and the flags register — plus sixteen wider ones used for floating-point and vector maths.

[^loadstore]: This is strictly true of ARM chips and similar designs, where arithmetic only ever happens between registers, and memory is touched solely by dedicated load and store instructions. x86 is looser — it can read, modify and write a memory location in a single instruction, and the second bug we found (the rarer city-state liberation one) does exactly that. But even on x86, at least one side of an operation has to be a register: there is no way to add two memory locations together directly without pulling one or both of them into CPU registers.

[^rprefix]: The `r` marks it as the 64-bit version. The original 16-bit register was `bp`, the 32-bit one `ebp` (for 'extended'), and the 64-bit one `rbp`. It's usually read as standing for 'register', matching the newer `r8` to `r15`, though AMD's manuals never actually state what the `r` stands for.

[^stackdirection]: Confusingly, the stack grows *downward*, from high memory addresses toward low ones — so the 'top' of the stack is the lowest address currently in use. This is because of a fun bit of history: on early machines the heap grew upward from one end of memory and the stack grew downward from the other, so the two shared whatever space was free without anyone having to decide the split in advance. Modern systems give the stack a fixed reservation nowhere near the heap — on the machine that produced this crash report the stack actually sits *below* the heap — but the direction is baked into the `push` instruction now and can never change.

[^startaddress]: We start a little earlier than the address `rip` gave us, because `rip` holds the one instruction that was executing — not the whole function it belongs to. Nothing in a shipped binary marks where functions begin, so you find the start by disassembling a stretch before the crash and reading backwards for the pattern that opens one: a `ret`, some padding, then a fresh `push rbp`, which is how most functions start. Walking back from `0x3db896` the first such boundary is `0x3db890`, which is where the command starts.

[^sdk]: If you have Civ V on Steam, you can find it by filtering for `tools` in your library. It's called "Sid Meier's Civilization V SDK", app 16830. It contains a `CvGameCoreSource` folder with 467 `.cpp` and 599 `.h` files, and is the complete gameplay source for the base game and both expansions. Steam only offers to *install* it on Windows, because the editor it ships with is a Visual Studio shell. You can still get the files on a Mac, though: run `open "steam://open/console"` in Terminal, then `download_depot 16830 16831` in the console tab that appears. There's also a [third-party mirror on GitHub](https://github.com/dmnd/CvGameCoreSource), which is easier to browse and search, and is what we actually used while debugging — but it's slightly different to what I see in the SDK, and its line numbers don't match the current official source, so it's worth going to the SDK itself before quoting anything precisely.

[^zeroing]: This looks arbitrary but is actually quite important. When AMD extended x86 to 64 bits they had to decide what a 32-bit write should do to the other half of the register. A modern CPU runs instructions out of order and in parallel wherever it can, which it can only do when it knows which instruction depends on which. If writing `eax` preserved the top of `rax`, then the new value of `rax` would depend both on this instruction *and* on whichever earlier instruction last wrote the register — a false dependency that stalls the pipeline while the processor waits to be sure. Zeroing means that whenever we do a write, the CPU can say 'ok, anything that depends on this write can now DEFINITELY proceed', which makes the write self-contained. The 8- and 16-bit names kept the old preserving behaviour for compatibility with decades of existing code, which is how writing to the bottom 8 bits just writes those bits, but writing the bottom 32 zeroes the top 32 as well. Weird, like many things in CPU-land.

[^argwidth]: The register that carries the argument, `rsi`, actually holds `0x00000000FFFFFFFF`. But `TeamTypes` is a 32-bit type, and the calling convention only puts a 32-bit argument in the *low* half of the register — so the upper half isn't part of the value at all. `0xFFFFFFFF` and `0x00000000FFFFFFFF` are the same number anyway; the crash report just prints every 64-bit register at full width.

[^flags]: Called `RFLAGS` on a 64-bit chip — it shows up in the crash report as `rfl: 0x0000000000000202`. It uses the 64 bits in the register to represent facts about the most recent result: was it zero, was it negative, did it overflow, and stuff like that. Not every instruction sets them — `mov` deliberately doesn't, so you can move things around without disturbing a comparison you made earlier.

[^twoscomplement]: [Two's complement](https://en.wikipedia.org/wiki/Two%27s_complement) is the near-universal way computers represent negative whole numbers. The top bit doubles as the minus sign. That's why `-1` is all ones: counting down from zero wraps around to the largest possible bit pattern. It also means "is this negative?" is very cheap to answer — you just look at the top bit.

[^codesigning]: A code signature is roughly 'a hash of the file', with two nuances. First, it's not one hash: the file is chopped into 4KB pages and each page is hashed separately, so the system can check code as it loads rather than all at once. This library has 1,423 of these pages. Those hashes live in a block called the CodeDirectory, and you can use the hashes to verify any specific page. 

    Second — the CodeDirectory is itself hashed and then *encrypted with the developer's private key*, alongside a chain of certificates proving the key belongs to them. On the original Civ V file, that chain reads 'Aspyr Media → Apple's Developer ID authority → Apple's root'. We couldn't replicate this if we tried, because we don't have Aspyr's private key (and if we could, then all their signing would be useless).

    So instead of forging their signature, we just make an *ad-hoc* one, which rebuilds the hashes honestly and claims nothing about who made the file. Apple Silicon won't run code carrying no signature at all, so this step isn't optional. It only works because Civ V's main executable doesn't use library validation, the setting that would otherwise demand every nested library be signed by the same developer. 

    Because we're doing this, there's no way to validate that the whole game's code was made by some trusted entity - which is true, it wasn't. It was made by me. This is why it's a good idea to read through the patching code, try to understand it, and run it yourself, rather than just downloading different game files (which could contain anything, including harmful stuff). At least this way, if I managed to make this patch turn your computer into a bitcoin miner, I needed to be *really* clever to do it in just 16 bytes.

[^claudenote]: *A note from Claude.* I found this bug and wrote the patch, and Arthur's account of that is accurate. The more useful thing to record is where I was wrong.

    The worst case was line 3. I claimed that instruction was what zeroed the top half of the register, and built an explanation on top of it. Arthur checked the dumped register values against what I'd said, and pointed out that the value had arrived already zeroed — the calling function did it, before our function ever ran. Going back to the caller's disassembly confirmed he was right. The explanation got better for it: that instruction doesn't zero anything, it chooses between two readings of bits that were already wrong.

    The other kind of mistake is harder to catch. Early on I told him this couldn't be fixed locally at all — that it needed a recompile the Mac can't do. That was a limiting claim I hadn't earned, and it closed off a question that turned out to have a sixteen-byte answer sitting in plain sight. I only looked again because he asked me to.

    A wrong assertion invites scrutiny. "That isn't possible" sounds like expertise, and ends the conversation. If you work with a model this way, the second kind is the one worth pushing on.