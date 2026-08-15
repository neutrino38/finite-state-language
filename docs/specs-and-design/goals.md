# Finite State language (FSL) for typescript / javascript 

Finite State Langage is the new name of Elixip DSL as documented in
https://github.com/neutrino38/elixip/blob/master/DSL.md
The intent here is to create a typescript or Javascript version of 
the Elixip DSL

## Purpose of the language


### Frontend

The first and formost purpose of FSL for typescript is to create
stateful frontend to provide web based communication UI. Web phone
Web chat, web bot UIs. 

As such, it needs to:

- play nice with best in class open source  JS SIP stack such as https://jssip.net/
- we should not tie ourself to any SIP library but rather make provision in the context
  to store elements in order to accomodaite any communication stack.
- see if we can be JS framework agnostic
- easily be integrated in frameworks such as React and other modern ones
- I am NOT looking for a lot of backward compatibility with old web software.

### Backend

A possible use, that is not a priorrity would be to use FSL for typescript
as telecommunication service description in backend on Node.js / Beam or 
équivalent.

## Packaging and dependencies

I guess it will end up as an npm package. I hope to have minimal dependencies
but it one dependent packages is critical in keeping the project simple, let's us it.
Every dependent package needs to be
- properly maintained
- have no major security risk

## Former implemntation

Back in the days, I did some kind of finite state machine that you can find in
the directory ../generique/VideoLiveAPI/ the main file to examine would be

- automate.js and ui-element.js

The other files try to implement a stateful UI. Do not copy the style or the software
design. Just understand what I want to do here.

## Language principles to keep

- Explicit state declaration -> to be compatible with UI state of used framework
- Explicit transition declation
- in the front end, the equivalent of on_events
- in node.js / beam something likewise
- readability, readability, readability

## Trivia

The acronym FSL can be also read as French Sign Language. Telecoms should be inclusive
by design.

# What I ask you, Claude!

- decide whether we should be in typescript or javascript
- how we address the JS framework:
  - can we remain a pure JS lib?
  - pure JS lib + one or two adaptor for major framework + node?
- create a detailed spec of the langage: fsl-js-ts.md that can be used to produce a software design
- create an implemntation plan
- great good README.md in English, not a spec. We should be stating the pupose of the project
  refer to Elixip and its DSL, refer to Sign language and inclusivity. Use puns around state like
  "State of affairs", be exiting and invite future devs to use it