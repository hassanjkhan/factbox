# -*- coding: utf-8 -*-
"""Builds data/cardaudio.json for factbox.app.

Runs are (first_card_n, last_card_n, bed, why). Card numbers are the 1-based
`n` in data/stacks.json. The emitted manifest is keyed by the 0-based value
read.html writes into data-card, with `n` carried inside each entry.
"""
import json, os, pathlib, re, sys

ROOT = str(pathlib.Path(__file__).resolve().parent.parent)

# --------------------------------------------------------------------------
# Bed vocabulary. 18 existing + 13 new.
# --------------------------------------------------------------------------
BEDS = {
 # ---- existing (files already in audio/) --------------------------------
 "palace":          ("existing", 0.85, "A fountain in a courtyard, cicadas beyond it. Mediterranean, hot, outdoors-but-enclosed. The Ptolemaic court."),
 "harbour":         ("existing", 1.00, "Sea and gulls at dusk. Alexandria from the quay."),
 "harbour-arrival": ("existing", 0.86, "Water on hulls, mass, a crowd a quarter-mile off. A ship coming in."),
 "sea":             ("existing", 1.00, "Open sea, no land."),
 "triumph":         ("existing", 0.95, "A crowd in the street. The busiest bed in the set."),
 "bath":            ("existing", 0.80, "Poured water in a hard, reverberant room."),
 "letter":          ("existing", 0.80, "A still room, a writing hand, a tread somewhere beyond the door."),
 "copies":          ("existing", 0.85, "A scriptorium. Dry, papery, patient. A document being examined."),
 "scroll":          ("existing", 0.85, "A still small interior. Nowhere in particular, which is the point."),
 "basket":          ("existing", 0.85, "Close, dry, small. A rustle inside a container."),
 "vials":           ("existing", 0.75, "A physician's table. Small glass, a pestle, careful handling."),
 "gallery":         ("existing", 0.80, "A big cool room with a long tail. The room where the paintings are."),
 "vault":           ("existing", 0.85, "A large dark stone interior with a long tail. Council chamber, cathedral, trial hall."),
 "wind":            ("existing", 0.85, "Open, dry, outdoors, no water. Desert, steppe, hillside."),
 "reactor":         ("existing", 0.85, "A machine room. Cold, continuous, mechanical, no century."),
 "door":            ("existing", 0.95, "ACCENT. A shut door in near-dark. The room going quiet."),
 "coil":            ("existing", 0.95, "ACCENT. A low drone under a question."),
 "search":          ("existing", 0.72, "ACCENT. The room after it was searched. The deliberate near-silence of the set."),
 # ---- new ---------------------------------------------------------------
 "battle":   ("new", 0.85, "An army at middle distance. Mass, metal, low ground rumble. No voices."),
 "fire":     ("new", 0.88, "A large fire close by. Broad roar with irregular crackle over it."),
 "storm":    ("new", 0.85, "Rain on hard ground with distant thunder. The sky closing over."),
 "night":    ("new", 0.78, "Outdoors after dark. Crickets, cool still air, one far-off dog."),
 "field":    ("new", 0.80, "Open warm countryside. Grass, insects, a bird or two. Galilee, Kentucky, a garden."),
 "river":    ("new", 0.85, "Moving fresh water close by, reeds on the bank."),
 "road":     ("new", 0.82, "Travel on foot outdoors. Grit underfoot, wide dry air."),
 "temple":   ("new", 0.85, "An enormous sacred stone interior. Vast slow air, a brazier hiss, a deep held tone."),
 "court":    ("new", 0.82, "An indoor throne room. Hard marble, a low human murmur that never resolves into words."),
 "crypt":    ("new", 0.78, "Small, dead, underground. No outside at all, a slow drip, a floor rumble. Tomb, cave, cell."),
 "dig":      ("new", 0.80, "An excavation outdoors. Loose grit and soil, thin wind, sparse tool contact."),
 "hall":     ("new", 0.82, "A 19th-century wooden interior with people in it. Theatre, courthouse, meeting house."),
 "void":     ("new", 0.80, "Vast and airless. A very low sustained tone with a slow shimmer far above it. Heaven, the sky, the cosmos."),
}

# --------------------------------------------------------------------------
# Per-stack runs.
# --------------------------------------------------------------------------
R = {}

R["01"] = [
 (1,3,"palace","Octavian invades Alexandria; Antony and Cleopatra barricaded inside the royal palace; she refuses to be paraded in Rome."),
 (4,4,"bath","'She took a bath, dressed in royal attire and ate a final meal' - poured water in a hard room."),
 (5,7,"basket","Plutarch's asp, smuggled into the mausoleum hidden beneath figs in a basket."),
 (8,10,"search","'No snake was ever found in the room.' Egypt becomes a province; the room after it was searched."),
]
R["02"] = [
 (1,2,"palace","The 'siren' charge, made about a queen in her own court."),
 (3,4,"harbour-arrival","Summoned to Tarsus in 41 BCE she arrives on a golden ship, dressed as Aphrodite, with music and attendants."),
 (5,7,"palace","Caesar then Antony; Octavian's war messaging against her - court politics."),
 (8,10,"basket","Carried in to Caesar bundled inside a bed-sack by her servant Apollodorus. Close, dry, small."),
 (11,11,"copies","Of her own writing, one word survives on a papyrus."),
]
R["03"] = [
 (1,2,"harbour","Alexandria: her tomb and the quarter it stood in."),
 (3,4,"sea","The 365 AD earthquake and tsunami submerged the royal quarter under the Mediterranean; theories point to sunken sites."),
 (5,6,"dig","Martinez's excavation: underground chambers, coins, mummies, a 1,305 metre tunnel to a sunken port."),
 (7,8,"temple","Taposiris Magna, the temple of Osiris, and why the search is aimed at it."),
]
R["04"] = [
 (1,2,"vault","Bosch's panel and the church that built the list. No place on the card - church ambient."),
 (3,5,"wind","'Evagrius Ponticus lived alone in the Egyptian desert trying to pray.' Open, dry, no water."),
 (6,7,"field","The Sermon on the Mount - Jesus teaching outdoors on a hillside (Carl Bloch, Giotto)."),
 (8,11,"scroll","Pure list: the seven, their opposing virtues, how to live them. No room at all - the neutral bed."),
]
R["05"] = [
 (1,5,"temple","A gold-covered chest treated as a throne, the Holy of Holies, Uzzah struck dead for touching it."),
 (6,7,"battle","The Ark carried into war and Jericho; the Philistines capture it; Babylon destroys Solomon's Temple in 586 BCE."),
 (8,9,"reactor","1988: the Sun Streak remote-viewing programme, a Cold War intelligence lab. Cold, continuous, mechanical."),
 (10,12,"dig","Destroyed, Babylon, Jerusalem or Ethiopia - no proposed location archaeologically verified."),
]
R["06"] = [
 (1,2,"night","Georges de La Tour's Magdalen of the Night Light; Mary healed of seven demons."),
 (3,4,"crypt","She witnesses the death, sees where the body was buried, returns and finds the tomb empty."),
 (5,6,"field","She mistakes the risen Jesus for a gardener; he says her name. A garden at first light."),
 (7,11,"copies","The Gospel of Mary: an incomplete surviving manuscript, private teachings, and Gregory's 591 sermon."),
]
R["07"] = [
 (1,1,"letter","A Gardner portrait and the words people used about his face. Still room - the topic's ambient."),
 (2,3,"triumph","Seven enormous public debates with Douglas, held outdoors in front of crowds."),
 (4,5,"battle","Secession, the Confederacy, the Civil War, the Emancipation Proclamation."),
 (6,9,"hall","Congress passes the 13th Amendment; Lee surrenders; Ford's Theatre, Booth in the box."),
]
R["07B"] = [
 (1,1,"bath","Rembrandt's Bathsheba. The hook is the bathing that starts it."),
 (2,3,"field","A shepherd boy in the youngest son's job, then Goliath. Open country."),
 (4,4,"bath","'One evening he saw a woman named Bathsheba bathing.'"),
 (5,6,"battle","Uriah refuses to leave the war; David puts him at the front of the fiercest fighting and pulls the line back."),
 (7,13,"court","Nathan sent to the king; 'You are the man'; the consequences inside David's own house; Absalom's revolt."),
]
R["08"] = [
 (1,2,"hall","Ford's Theatre, an 1865 wooden auditorium with an audience in it."),
 (3,3,"door","'Then Parker disappeared' - the officer steps away from the door outside the box."),
 (4,5,"hall","Booth is a familiar face in the building; he fires during a laugh from the audience."),
 (6,6,"road","He jumps to the stage, escapes Washington on horseback and is on the run for 12 days."),
 (7,8,"letter","Legislation signed on 14 April 1865; the ordinary paperwork around the death."),
]
R["09"] = [
 (1,7,"reactor","Reactor 4, a turbine, cooling pumps, a safety test at low power, the surge. A machine room."),
 (8,8,"fire","Firefighters sent toward burning debris without being told what it was."),
 (9,10,"reactor","Pripyat unevacuated for 36 hours while the destroyed reactor kept releasing; the fire ran 10 days."),
 (11,12,"wind","A permanent exclusion zone and an abandoned city. Open, dry, nobody there."),
]
R["10"] = [
 (1,1,"crypt","'Imprisoned in Rome... about to get his head chopped off.' A small dead stone room."),
 (2,4,"road","Damascus road; four journeys, Antioch to Corinth to Ephesus; flogged, stoned and shipwrecked."),
 (5,8,"crypt","Arrest, appeal, house arrest in Rome, Nero's persecution, the beheading. Back in the cell."),
 (9,9,"copies","He wrote most of the New Testament without having met Jesus."),
]
R["11"] = [
 (1,1,"sea","'Before any of that, he was a fisherman named Simon.'"),
 (2,4,"field","Renamed the rock; the inner circle; the Transfiguration. The Galilee years, outdoors."),
 (5,6,"night","Three denials in a courtyard at night, and a rooster crowing at dawn."),
 (7,8,"triumph","Preaching publicly, healings, leading the earliest community; then Rome under Nero."),
 (9,11,"vault","St Peter's Basilica raised over the traditional site of his grave; 266 successors."),
]
R["12"] = [
 (1,2,"field","A married man whose mother-in-law Jesus heals of a fever. Domestic Galilee."),
 (3,5,"night","The arrest: a drawn sword, Malchus's ear, three denials before the rooster."),
 (6,6,"triumph","Despite the failures he becomes the central leader of the movement."),
 (7,8,"vault","Crucified in Rome under Nero; the institution built on him."),
]
R["13"] = [
 (1,1,"coil","'Satan isn't God's rival' - Brueghel's Fall of the Rebel Angels. A low drone under the question."),
 (2,5,"vault","Doctrine: created being, adversary in Job, permitted boundaries. No place on the card - church ambient."),
 (6,7,"fire","Revelation's dragon and the lake of fire; a rebel thrown into it."),
 (8,8,"vault","Why we prefer the rivalry. No place - church ambient."),
]
R["14"] = [
 (1,1,"void","A man shown visions of what happens before the end. Vast and airless."),
 (2,2,"sea","'Writing from Patmos, a small Greek island Rome used to hold prisoners.'"),
 (3,4,"void","God's throne, strange heavenly creatures, a scroll sealed with seven seals."),
 (5,9,"battle","Four Horsemen bringing conquest, war, famine and death; trumpets, enormous armies, Har Megiddo - a hill that guarded a trade route and was a battlefield for centuries."),
 (10,12,"void","The rider on the white horse, the lake of fire, a new heaven and a new earth."),
]
R["15"] = [
 (1,2,"court","A cuneiform tablet and the founding of the Achaemenid empire. An imperial room."),
 (3,4,"battle","Babylon captured in 539 BCE; the Cylinder describing what he did with the sanctuaries after."),
 (5,6,"temple","Exiles allowed back to Jerusalem to rebuild the Temple; Isaiah 45 calls him anointed."),
 (7,9,"court","A vast multicultural empire governed by accommodation; his standing in Iranian history."),
]
R["16"] = [
 (1,2,"crypt","1947: manuscripts found in caves near the Dead Sea; roughly 900 from the caves around Qumran."),
 (3,9,"copies","The Great Isaiah Scroll, the Masoretic text, scribal variants - manuscripts on a table being compared."),
]
R["17"] = [
 (1,2,"crypt","A queen's tomb nobody has found, and Antony probably in it with her."),
 (3,3,"harbour","'The problem is Alexandria' - earthquakes and rising seas have left parts of it underwater."),
 (4,6,"temple","Taposiris Magna, a temple to Osiris; tunnels and Cleopatra coins; her identification with Isis."),
 (7,9,"dig","2,000 years of earthquakes, flooding, construction and looting; the search that outlives the evidence."),
]
R["18"] = [
 (1,2,"palace","12 August 30 BCE, Octavian in control of Alexandria, the queen in her own quarters."),
 (3,4,"bath","'Cleopatra bathed, ate a final meal and sent Octavian a message.' Octavian's men arrive too late."),
 (5,7,"basket","The asp smuggled in inside a basket of figs; a country man carrying fruit past the guards; or a hollow hairpin."),
 (8,9,"gallery","'Two thousand years of painters picked the image, and the image is what survived.'"),
]
R["19"] = [
 (1,2,"palace","Two relationships that became the power struggle that ended the Republic."),
 (3,4,"court","Carried in to Caesar in a bedding sack past her brother's guards; Caesar stabbed to death by senators in 44 BCE."),
 (5,6,"harbour-arrival","Summoned to Tarsus in 41 BCE, she arrives staged as a goddess on a gilded barge."),
 (7,9,"sea","War declared in 32 BCE and the devastating defeat at Actium; Egypt annexed."),
]
R["20"] = [
 (1,4,"palace","A queen in her own court who did not need either man; fighting her brother for Egypt."),
 (5,6,"basket","Concealed inside a sack used for bedding and carried into Caesar's quarters."),
 (7,7,"palace","Then came Mark Antony - another alliance made from the same throne."),
 (8,9,"triumph","Octavian's victory, the annexation of Egypt, and Rome's version of her."),
]
R["21"] = [
 (1,2,"field","Born in a one-room log cabin in Kentucky in 1809, largely self-educated. Frontier country."),
 (3,6,"hall","Ran for the Illinois legislature and lost; four terms; the 1858 Senate race; the 1860 win."),
 (7,7,"battle","Weeks after he took office the Civil War began."),
 (8,8,"letter","Why the failure list gets shared. No place on the card - the topic's ambient."),
]
R["22"] = [
 (1,1,"basket","'Someone at your front doorstep with a basket of fruit, and the fruit is rotten.'"),
 (2,2,"copies","Unpacking Galatians 5 - a letter being read."),
 (3,8,"field","Two kinds of fruit; nine qualities; 'fruit grows naturally from what a plant is rooted in'; the fruit reveals the tree."),
 (9,9,"copies","Why this test outlasted the letter it was written in."),
]
R["23"] = [
 (1,2,"night","La Tour's night-light Magdalen; the 591 sermon that made her a prostitute."),
 (3,3,"road","'Mary actually travelled with Jesus' and the women who funded the ministry."),
 (4,5,"crypt","At the crucifixion and the burial; she returns to the tomb and finds it empty."),
 (6,7,"copies","The Gospel of Mary, a noncanonical text in which Peter challenges her authority."),
 (8,8,"gallery","'Centuries of paintings, sermons and plays had already fixed her, and art does not issue retractions.'"),
]
R["24"] = [
 (1,2,"triumph","Jerusalem packed with Passover pilgrims; large crowds; Rome nervous about unrest."),
 (3,4,"temple","Overturning tables and disrupting commerce in the Jerusalem Temple; the authorities there want him stopped."),
 (5,5,"court","Accused before Pilate of presenting himself as King of the Jews."),
 (6,8,"storm","The sign over his head at the execution; crucifixion as Roman public punishment."),
]
R["25"] = [
 (1,1,"void","Astronomical calculation applied to an ancient date. Vast and airless."),
 (2,3,"storm","'Darkness covered the land for roughly three hours'; why a solar eclipse cannot do that."),
 (4,8,"void","A partial lunar eclipse on 3 April 33 CE, the moon reddened by Earth's shadow, visible from Jerusalem at moonrise."),
]
R["26"] = [
 (1,1,"coil","'Why did some early Christians believe the Christian God was evil?' A low drone under the question."),
 (2,3,"void","A perfect unknowable God beyond the material universe, and the Demiurge who made ours."),
 (4,5,"vault","Identifying that lesser being with the creator of the Hebrew Bible. No place - church ambient."),
 (6,6,"field","The Garden of Eden reread: the serpent helping humanity to knowledge."),
 (7,8,"void","Jesus arriving from the higher realm; gnosis waking the divine spark; the side that lost."),
 (10,10,"copies","'A jar turned up in 1945 and they finally spoke in their own voice.' Nag Hammadi."),
]
R["27"] = [
 (1,3,"palace","Four children born into the Ptolemaic court; Caesarion, then Antony's twins."),
 (4,5,"battle","Octavian invades Egypt and captures Alexandria; the teenage Caesarion is executed."),
 (6,7,"triumph","The three surviving children displayed in Octavian's triumph through Rome."),
 (8,8,"search","'They walk into a Roman triumph and then out of the record entirely. The silence is louder than an ending.'"),
]
R["28"] = [
 (1,3,"hall","Ford's Theatre again: Booth takes the president and escapes on horseback."),
 (4,6,"letter","Powell forces his way into Seward's house and stabs him in his bed; Atzerodt loses his nerve at the hotel. A private house at night."),
 (7,7,"road","A 12-day manhunt ending at a Virginia farm."),
 (8,8,"letter","Why the full plot is forgotten. No place on the card - the topic's ambient."),
]
R["29"] = [
 (1,2,"temple","He had taught at the Temple in front of crowds; the authorities want him taken quietly during Passover."),
 (3,4,"night","'He agreed to lead an armed group to Jesus at night, away from the crowds.' The kiss in Gethsemane."),
 (5,8,"temple","Thirty pieces of silver from the chief priests, thrown back into the Temple."),
]
R["30"] = [
 (1,4,"copies","Gospels, Paul's letters, Thomas, the Shepherd of Hermas - different churches holding different collections."),
 (5,5,"vault","The Council of Nicaea in 325, and what its surviving records actually show."),
 (6,8,"copies","Athanasius's 367 Easter letter listing 27 books; centuries of use and argument."),
]
R["31"] = [
 (1,3,"battle","An empire taken by 32: Macedonia, the invasion of Persia, Darius III defeated."),
 (4,5,"court","Ill in Babylon and dead in days; his generals left fighting over the succession."),
 (6,6,"crypt","The body taken to Egypt and placed in an elaborate tomb in Alexandria."),
 (7,8,"dig","The tomb vanishes from the record; more than 140 official attempts to find it, all failed."),
]
R["32"] = [
 (1,2,"field","A teenage peasant in a village who says saints spoke to her."),
 (3,3,"court","At 17 she travels to Charles and convinces his court to take her seriously."),
 (4,5,"battle","The siege of Orleans lifted in 1429, the coronation at Reims, then capture by Burgundian forces in 1430."),
 (6,6,"fire","'Convicted and burned at the stake in Rouen in 1431.'"),
 (7,8,"vault","A second church proceeding overturns the judgment; canonisation."),
]
R["33"] = [
 (1,1,"fire","Blake's Satan enthroned in Hell - the image the card is there to correct."),
 (2,5,"vault","Created being, not a king; a roaring lion on Earth; permitted limits in Job. No place - church ambient."),
 (6,7,"fire","'Satan is thrown into the lake of fire, where he is tormented. He isn't running the place.'"),
 (8,8,"gallery","'The throne, the pitchfork and the underworld kingdom come from Dante and Milton.'"),
]
R["34"] = [
 (1,1,"gallery","'Creatures that look nothing like the angels you see in paintings.'"),
 (2,7,"void","Ezekiel's four faces, seraphim with six wings around a throne, intersecting wheels full of eyes."),
 (8,8,"gallery","'Most people meet angels through Renaissance painting first and the text second.'"),
]
R["35"] = [
 (1,1,"copies","What the Gospels say and what the word means. A text being read."),
 (2,3,"field","Mark 6: people in his hometown name four brothers; his family are not convinced."),
 (4,4,"vault","James emerges as a leader of the Jerusalem Christian community."),
 (5,8,"copies","Interpretive dispute between traditions with no place attached - the topic's ambient."),
]
R["36"] = [
 (1,2,"court","Governor of Judea under Tiberius from about 26 to 36 CE."),
 (3,3,"storm","All four Gospels place Jesus before him; Roman authority imposes the crucifixion."),
 (4,5,"battle","Roman standards, Temple funds and violence; his forces attack a Samaritan gathering at Mount Gerizim."),
 (6,7,"search","Ordered home to answer for his conduct; Tiberius already dead; then the record loses him entirely."),
 (8,8,"vault","'Named in the creed millions recite weekly.' A stone from Caesarea is the only contemporary proof."),
]
R["37"] = [
 (1,2,"copies","A book quoted by Jude and left out of most Bibles; Genesis's sons of God and the Nephilim."),
 (3,4,"storm","Watchers descending to Earth, teaching weapons and magic; violent giants; the wickedness before the flood."),
 (5,5,"crypt","'The rebellious angels are bound and await judgment.'"),
 (6,8,"copies","Jude quotes it; the Ethiopian Orthodox Tewahedo Church preserved the complete work as Scripture."),
]
R["38"] = [
 (1,3,"court","Back in Babylon planning campaigns; his soldiers file past his bed as he lies unable to speak."),
 (4,6,"vials","Typhoid and other infections; the poisoning traditions; the body that reportedly did not decompose."),
 (7,7,"battle","His commanders tear the territories apart fighting over them."),
 (8,8,"search","'No body exists to test.' A question that cannot be closed."),
]
R["39"] = [
 (1,2,"court","Ingres's enthroned emperor, and the height recorded after his death in French inches."),
 (3,5,"battle","Britain's caricature war; 'Le Petit Caporal' and his relationship with his soldiers; Imperial Guards with height requirements."),
 (6,8,"gallery","Gillray's prints did the work; the image outlived the man and became a psychological term."),
]
R["40"] = [
 (1,1,"fire","'Joan of Arc was burned alive for heresy.'"),
 (2,3,"vault","An ecclesiastical court under English influence; accusations about visions, authority and men's clothing."),
 (4,4,"fire","'On 30 May 1431 she was burned at the stake in Rouen.'"),
 (5,5,"battle","The Hundred Years' War continues; England loses nearly all its French territories."),
 (6,8,"vault","The 1456 annulment and the 1920 canonisation - the same kind of room, reversing itself."),
]
R["41"] = [
 (1,1,"palace","An emperor at a window while a city burns - the image the card is correcting."),
 (2,4,"fire","A catastrophic fire in July 64 CE burning for days; large sections of Rome destroyed; the rumoured song about Troy."),
 (5,8,"palace","The Domus Aurea built across Rome afterwards, and the blame handed to Christians from it."),
]
R["42"] = [
 (1,2,"vault","Diocletian's edicts from 303: churches destroyed and Scriptures surrendered."),
 (3,5,"battle","Constantine against Maxentius at the Milvian Bridge in 312; a sign put on the soldiers' equipment; Maxentius drowned."),
 (6,6,"court","The 313 agreement granting toleration and restoring confiscated property."),
 (7,8,"vault","Imperial patronage of churches; Theodosius; a persecuted movement moved to the centre."),
]
R["43"] = [
 (1,1,"river","'Poisoned, shot, beaten, thrown into a freezing river.'"),
 (2,3,"court","Access to the imperial family; lured to the Moika Palace in Petrograd in December 1916."),
 (4,5,"vials","Cakes and wine laced with cyanide; then shot several times. A poisoner's table."),
 (6,8,"river","The body thrown into the Malaya Nevka and recovered days later; the autopsy found no water in his lungs."),
]
R["44"] = [
 (1,3,"wind","Temujin born into the politics of the Mongolian steppe; the steppe unified by 1206."),
 (4,5,"battle","Mongol armies across northern China and Central Asia; he dies on campaign against the Western Xia."),
 (6,6,"door","'He wanted an unmarked or concealed burial'; everyone who met the funeral procession killed. The room going quiet."),
 (7,8,"dig","Searches around Burkhan Khaldun; no tomb conclusively identified in 800 years."),
]
R["45"] = [
 (1,2,"temple","Twelve-year-old Jesus discussing Scripture with the teachers at the Temple."),
 (3,4,"field","Eighteen years missing; a tekton - a craftsman or builder - living and working in Galilee."),
 (5,6,"road","Invented childhood miracles, then the much later claims of journeys to India and Tibet."),
 (7,8,"search","'Eighteen years of silence in the most examined life in history.'"),
]
R["46"] = [
 (1,1,"field","'The Garden of Eden supposedly had an address.'"),
 (2,5,"river","A river flowing from Eden and dividing into four: Pishon, Gihon, Tigris and Euphrates."),
 (6,6,"dig","Mesopotamia, Armenia, the Persian Gulf - none archaeologically demonstrated."),
 (7,8,"field","Eden as a garden and a sacred landscape rather than a place on a map."),
]
R["47"] = [
 (1,1,"storm","Grunewald's crucifixion, and the claim that the suffering in it did not happen."),
 (2,4,"vault","Docetism: a divine being and corruptible matter. No place on the card - church ambient."),
 (5,6,"copies","The letters of John insisting Jesus came 'in the flesh', written against these disputes."),
 (7,8,"vault","The doctrine written to close the question, and the position still rejected by name."),
]
R["48"] = [
 (1,2,"copies","'Let the reader with wisdom calculate it'; Greek and Hebrew letters carrying numerical values."),
 (3,3,"fire","Nero Caesar in Hebrew letters totals 666 - and Nero was infamous for burning Christians in Rome."),
 (4,8,"copies","Manuscripts giving 616 instead; centuries of people recalculating the number onto new enemies."),
]
R["49"] = [
 (1,1,"void","Signorelli's end-times fresco, and a word that never appears in Revelation."),
 (2,5,"copies","1 and 2 John, Revelation's beast, 2 Thessalonians' man of lawlessness - three texts, not one figure."),
 (6,7,"vault","Centuries of interpretation merging the characters. No place - church ambient."),
 (8,8,"gallery","'One terrifying end-times figure is more filmable than a category of people.'"),
]
R["50"] = [
 (1,2,"court","Warned about the Ides and walking into the Senate anyway; Spurinna's warning."),
 (3,3,"night","Calpurnia's disturbing dreams the night before."),
 (4,8,"court","Decimus Brutus talks him into going; Artemidorus's written warning; the senators close in and stab him 23 times."),
 (9,9,"gallery","'Shakespeare gave it a line, and the line gave the date an afterlife.'"),
]

# --------------------------------------------------------------------------
# Build + verify
# --------------------------------------------------------------------------
stacks = json.load(open(os.path.join(ROOT, "data/stacks.json")))["stacks"]
by_id = dict((s["id"], s) for s in stacks)

TOPIC_BED = {
 "cleopatra": "palace", "ancient_world": "palace", "old_testament": "wind",
 "new_testament": "copies", "church_history": "vault", "us_history": "letter",
 "medieval_modern": "vault", "disaster": "reactor",
}
# Runs whose bed is the topic ambient / the neutral bed with no evidence on the card.
FALLBACK_RUNS = set([
 ("04",1),("04",8),("07",1),("13",2),("13",8),("21",8),("28",8),
 ("33",2),("35",5),("47",2),("47",7),("49",6),("26",4),
])

out = {
 "version": 1,
 "note": ("Per-card bed map for read.html. Resolution, most specific first: "
          "stacks[stack].cards[data-card] -> stacks[stack].beats[beat] -> stacks[stack].bed "
          "-> topics[topic].beats[beat] -> topics[topic].bed -> default. Card keys are the "
          "0-based value read.html writes into data-card; `n` inside each entry is the 1-based "
          "card number in data/stacks.json. An unresolved card HOLDS whatever is already playing. "
          "See AUDIO-CARDS.md."),
 "base": "audio/",
 "default": "scroll",
 "beds": {},
 "topics": {},
 "stacks": {},
}

used = {}
total = 0
changes_total = 0
fb_cards = 0
meta_cards = 0
meta_re = re.compile(r"^(why|legacy|the legacy)\b", re.I)

for sid in [s["id"] for s in stacks]:
    s = by_id[sid]
    runs = R[sid]
    ns = [c["n"] for c in s["cards"]]
    heads = dict((c["n"], (c.get("head") or "")) for c in s["cards"])
    cards = {}
    seen = []
    for (a, b, bed, why) in runs:
        assert bed in BEDS, (sid, bed)
        fb = (sid, a) in FALLBACK_RUNS
        for n in range(a, b + 1):
            if n not in ns:
                continue                      # stack 26 has no card 9
            key = str(ns.index(n))            # 0-based, matches data-card
            e = {"n": n, "bed": bed, "why": why}
            if fb:
                e["fb"] = True
                fb_cards_add = True
            cards[key] = e
            seen.append(n)
            used[bed] = used.get(bed, 0) + 1
            total += 1
            if fb:
                fb_cards += 1
            if meta_re.match(heads[n].strip()):
                meta_cards += 1
    assert sorted(seen) == sorted(ns), (sid, sorted(seen), sorted(ns))
    # bed changes across the story, in card order
    seq = [cards[str(i)]["bed"] for i in range(len(ns))]
    ch = sum(1 for i in range(1, len(seq)) if seq[i] != seq[i - 1])
    changes_total += ch
    # No stack-level `bed` or `beats` here on purpose: this file is card-level
    # only, so data/audio.json's stack map stays the authority underneath it and
    # a missing card key degrades to the story's own bed, then to its topic.
    out["stacks"][sid] = {
        "title": s["title"], "topic": s.get("topic", ""),
        "changes": ch, "cards": cards,
    }

for k in sorted(used):
    kind, gain, desc = BEDS[k]
    out["beds"][k] = {"file": k + ".mp3", "gain": gain, "status": kind, "note": desc}
for t, b in TOPIC_BED.items():
    out["topics"][t] = {"bed": b}

# ---- verification --------------------------------------------------------
expected = sum(len(s["cards"]) for s in stacks)
assert total == expected == 450, (total, expected)
for k in used:
    assert k in out["beds"], k
for k, v in out["beds"].items():
    if v["status"] == "existing":
        p = os.path.join(ROOT, "audio", k + ".mp3")
        assert os.path.exists(p), "missing existing bed file: " + p

path = os.path.join(ROOT, "data/cardaudio.json")
json.dump(out, open(path, "w"), indent=1, ensure_ascii=False, sort_keys=False)
json.load(open(path))          # parses

newn = sum(1 for v in out["beds"].values() if v["status"] == "new")
print("cards assigned      : %d / %d" % (total, expected))
print("stacks              : %d" % len(out["stacks"]))
print("beds referenced     : %d  (%d existing, %d new)" % (len(out["beds"]), len(out["beds"]) - newn, newn))
print("bed changes / story : %.2f  (total %d over %d stories)" % (changes_total / 51.0, changes_total, 51))
print("topic-ambient fallback cards : %d  (%.1f%%)" % (fb_cards, 100.0 * fb_cards / total))
print("meta 'WHY...' cards held on the surrounding bed : %d  (%.1f%%)" % (meta_cards, 100.0 * meta_cards / total))
print("file bytes          : %d" % os.path.getsize(path))
print()
print("bed usage (cards):")
for k in sorted(used, key=lambda k: -used[k]):
    print("  %-16s %4d  %s" % (k, used[k], BEDS[k][0]))
