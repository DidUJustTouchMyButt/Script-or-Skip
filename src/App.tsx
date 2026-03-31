/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
import { motion, AnimatePresence } from "motion/react";
import { 
  Film, Trophy, Play, RotateCcw, CheckCircle2, XCircle, 
  Loader2, LogIn, LogOut, Users, Copy, Check, Share2, ArrowRight
} from 'lucide-react';
import { 
  signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, User 
} from 'firebase/auth';
import { 
  doc, setDoc, updateDoc, onSnapshot, getDoc, serverTimestamp, 
  collection, query, where, getDocs, deleteDoc
} from 'firebase/firestore';
import { auth, db } from './firebase';

// --- Types ---

interface PlayerData {
  uid: string;
  name: string;
  photoURL: string;
  score: number;
  role: 'selector' | 'guesser';
}

interface RoomData {
  id: string;
  status: 'waiting' | 'selection' | 'guessing' | 'result';
  players: { [uid: string]: PlayerData };
  currentMovie?: string;
  quotes?: { text: string; isReal: boolean }[];
  lastResult?: { correct: boolean; realQuote: string };
  selectorId: string;
  guesserId?: string;
  createdAt: any;
}

// --- AI Service ---

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

async function fetchQuotes(movie: string): Promise<{ real: string; fakes: string[] }> {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `For the movie "${movie}", provide one real iconic line from the script and two fake but plausible lines that sound like they could be from that movie. The fakes should be stylistically similar.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          real: { type: Type.STRING, description: "A real iconic line from the movie script" },
          fakes: { 
            type: Type.ARRAY, 
            items: { type: Type.STRING },
            description: "Two fake but plausible lines"
          }
        },
        required: ["real", "fakes"]
      }
    }
  });

  return JSON.parse(response.text || '{}');
}

// --- Error Handling ---

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Error Boundary ---

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: any }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let errorMessage = "Something went wrong.";
      try {
        const parsed = JSON.parse(this.state.error.message);
        if (parsed.error) errorMessage = `Game Error: ${parsed.error}`;
      } catch (e) {
        errorMessage = this.state.error.message || errorMessage;
      }

      return (
        <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center p-6 text-center">
          <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mb-6">
            <XCircle className="w-8 h-8 text-red-500" />
          </div>
          <h2 className="text-2xl font-bold mb-4">Oops!</h2>
          <p className="text-gray-400 mb-8 max-w-xs">{errorMessage}</p>
          <button 
            onClick={() => window.location.reload()}
            className="px-8 py-3 bg-white text-black rounded-xl font-bold uppercase text-xs tracking-widest hover:bg-orange-500 hover:text-white transition-all"
          >
            Reload Game
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

// --- Components ---

export default function App() {
  return (
    <ErrorBoundary>
      <GameContent />
    </ErrorBoundary>
  );
}

function GameContent() {
  const [user, setUser] = useState<User | null>(null);
  const [room, setRoom] = useState<RoomData | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [movieInput, setMovieInput] = useState('');

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  // Room Listener
  useEffect(() => {
    if (!room?.id) return;
    const unsubscribe = onSnapshot(doc(db, 'rooms', room.id), (snapshot) => {
      if (snapshot.exists()) {
        setRoom({ id: snapshot.id, ...snapshot.data() } as RoomData);
      } else {
        setRoom(null);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `rooms/${room.id}`);
    });
    return unsubscribe;
  }, [room?.id]);

  // --- Handlers ---

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  const handleLogout = () => signOut(auth);

  const createRoom = async () => {
    if (!user) return;
    setActionLoading(true);
    try {
      const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
      const newRoom: Partial<RoomData> = {
        status: 'waiting',
        players: {
          [user.uid]: {
            uid: user.uid,
            name: user.displayName || 'Player 1',
            photoURL: user.photoURL || '',
            score: 0,
            role: 'selector'
          }
        },
        selectorId: user.uid,
        createdAt: serverTimestamp()
      };
      await setDoc(doc(db, 'rooms', roomId), newRoom);
      setRoom({ id: roomId, ...newRoom } as RoomData);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'rooms/new');
    }
    setActionLoading(false);
  };

  const joinRoom = async (roomId: string) => {
    if (!user) return;
    setActionLoading(true);
    try {
      const roomRef = doc(db, 'rooms', roomId.toUpperCase());
      const snapshot = await getDoc(roomRef);
      
      if (snapshot.exists()) {
        const data = snapshot.data() as RoomData;
        if (Object.keys(data.players).length < 2) {
          const updatedPlayers = {
            ...data.players,
            [user.uid]: {
              uid: user.uid,
              name: user.displayName || 'Player 2',
              photoURL: user.photoURL || '',
              score: 0,
              role: 'guesser'
            }
          };
          await updateDoc(roomRef, { 
            players: updatedPlayers,
            status: 'selection',
            guesserId: user.uid
          });
          setRoom({ id: roomId, ...data, players: updatedPlayers, status: 'selection', guesserId: user.uid });
        } else {
          alert("Room is full!");
        }
      } else {
        alert("Room not found!");
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `rooms/${roomId}`);
    }
    setActionLoading(false);
  };

  const submitMovie = async () => {
    if (!room || !movieInput.trim() || !user) return;
    setActionLoading(true);
    try {
      const { real, fakes } = await fetchQuotes(movieInput);
      const allQuotes = [
        { text: real, isReal: true },
        ...fakes.map(f => ({ text: f, isReal: false }))
      ].sort(() => Math.random() - 0.5);

      await updateDoc(doc(db, 'rooms', room.id), {
        currentMovie: movieInput,
        quotes: allQuotes,
        status: 'guessing'
      });
      setMovieInput('');
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `rooms/${room.id}`);
    }
    setActionLoading(false);
  };

  const submitGuess = async (index: number) => {
    if (!room || !user || room.status !== 'guessing') return;
    try {
      const quote = room.quotes![index];
      const isCorrect = quote.isReal;
      const realQuote = room.quotes!.find(q => q.isReal)!.text;

      const updatedPlayers = { ...room.players };
      let nextSelectorId = room.selectorId;
      let nextGuesserId = room.guesserId;

      if (isCorrect) {
        // Guesser becomes selector
        nextSelectorId = user.uid;
        nextGuesserId = room.selectorId;
        updatedPlayers[nextSelectorId].role = 'selector';
        updatedPlayers[nextGuesserId!].role = 'guesser';
      } else {
        // Selector scores, stays selector
        updatedPlayers[room.selectorId].score += 1;
      }

      await updateDoc(doc(db, 'rooms', room.id), {
        status: 'result',
        lastResult: { correct: isCorrect, realQuote },
        players: updatedPlayers,
        selectorId: nextSelectorId,
        guesserId: nextGuesserId
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `rooms/${room.id}`);
    }
  };

  const nextRound = async () => {
    if (!room) return;
    try {
      await updateDoc(doc(db, 'rooms', room.id), {
        status: 'selection',
        currentMovie: '',
        quotes: [],
        lastResult: null
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `rooms/${room.id}`);
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(room?.id || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // --- UI Helpers ---

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-orange-500 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center p-6 text-center">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-sm space-y-8"
        >
          <div className="w-20 h-20 bg-orange-600 rounded-3xl flex items-center justify-center mx-auto shadow-2xl shadow-orange-600/20">
            <Film className="w-10 h-10" />
          </div>
          <div className="space-y-4">
            <h1 className="text-4xl font-black tracking-tighter uppercase italic">Script or Skip</h1>
            <p className="text-gray-400">The ultimate movie quote showdown. Sign in to play with friends anywhere.</p>
          </div>
          <button 
            onClick={handleLogin}
            className="w-full py-4 bg-white text-black rounded-2xl font-bold uppercase tracking-widest flex items-center justify-center gap-3 hover:bg-orange-500 hover:text-white transition-all active:scale-95"
          >
            <LogIn className="w-5 h-5" /> Sign in with Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-orange-500/30 overflow-x-hidden">
      {/* Background Decor */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none opacity-20">
        <div className="absolute -top-24 -left-24 w-96 h-96 bg-orange-600 rounded-full blur-[120px]" />
        <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-blue-600 rounded-full blur-[120px]" />
      </div>

      <main className="relative z-10 max-w-md mx-auto px-6 py-8 flex flex-col min-h-screen">
        {/* Header */}
        <header className="flex justify-between items-center mb-8">
          <div className="flex items-center gap-2">
            <Film className="w-5 h-5 text-orange-500" />
            <span className="text-sm font-black uppercase italic tracking-tighter">Script or Skip</span>
          </div>
          <button onClick={handleLogout} className="p-2 text-gray-500 hover:text-white transition-colors">
            <LogOut className="w-5 h-5" />
          </button>
        </header>

        <div className="flex-1 flex flex-col">
          <AnimatePresence mode="wait">
            {!room ? (
              <motion.div 
                key="lobby"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.05 }}
                className="space-y-8 my-auto"
              >
                <div className="space-y-2">
                  <h2 className="text-3xl font-bold tracking-tight">Welcome, {user.displayName?.split(' ')[0]}</h2>
                  <p className="text-gray-400">Start a new game or join a friend's room.</p>
                </div>

                <div className="grid gap-4">
                  <button 
                    onClick={createRoom}
                    disabled={actionLoading}
                    className="w-full py-6 bg-white text-black rounded-3xl font-bold uppercase tracking-widest flex items-center justify-center gap-3 hover:bg-orange-500 hover:text-white transition-all active:scale-95 disabled:opacity-50"
                  >
                    {actionLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Play className="w-5 h-5 fill-current" /> Create Room</>}
                  </button>

                  <div className="relative flex items-center py-4">
                    <div className="flex-grow border-t border-white/10"></div>
                    <span className="flex-shrink mx-4 text-gray-600 text-xs font-bold uppercase tracking-widest">OR</span>
                    <div className="flex-grow border-t border-white/10"></div>
                  </div>

                  <div className="space-y-3">
                    <input 
                      type="text"
                      placeholder="Enter Room Code"
                      className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-center text-xl font-mono uppercase tracking-widest focus:outline-none focus:border-orange-500/50"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') joinRoom((e.target as HTMLInputElement).value);
                      }}
                    />
                    <p className="text-[10px] text-center text-gray-600 uppercase tracking-widest font-bold">Press Enter to Join</p>
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div 
                key="game"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex-1 flex flex-col"
              >
                {/* Game Header */}
                <div className="flex justify-between items-center mb-8 bg-white/5 p-4 rounded-2xl border border-white/10">
                  {(Object.values(room.players) as PlayerData[]).map(p => (
                    <div key={p.uid} className={`flex items-center gap-3 ${p.uid === user.uid ? 'order-first' : 'order-last text-right'}`}>
                      {p.uid === user.uid ? (
                        <>
                          <img src={p.photoURL} className="w-10 h-10 rounded-full border-2 border-orange-500" alt="" />
                          <div>
                            <p className="text-[10px] font-bold uppercase text-orange-500">{p.role}</p>
                            <p className="text-lg font-mono font-bold leading-none">{p.score}</p>
                          </div>
                        </>
                      ) : (
                        <>
                          <div>
                            <p className="text-[10px] font-bold uppercase text-gray-500">{p.role}</p>
                            <p className="text-lg font-mono font-bold leading-none">{p.score}</p>
                          </div>
                          <img src={p.photoURL} className="w-10 h-10 rounded-full border-2 border-transparent" alt="" />
                        </>
                      )}
                    </div>
                  ))}
                </div>

                {/* Game Phases */}
                <div className="flex-1 flex flex-col justify-center">
                  <AnimatePresence mode="wait">
                    {room.status === 'waiting' && (
                      <motion.div key="waiting" className="text-center space-y-6">
                        <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mx-auto animate-pulse">
                          <Users className="w-8 h-8 text-gray-500" />
                        </div>
                        <div className="space-y-2">
                          <h3 className="text-xl font-bold">Waiting for Player 2</h3>
                          <p className="text-gray-500 text-sm">Share this code with your friend:</p>
                        </div>
                        <button 
                          onClick={copyLink}
                          className="px-8 py-4 bg-white/5 border border-white/10 rounded-2xl flex items-center gap-3 mx-auto hover:bg-white/10 transition-all active:scale-95"
                        >
                          <span className="text-2xl font-mono font-bold tracking-[0.3em]">{room.id}</span>
                          {copied ? <Check className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5 text-gray-500" />}
                        </button>
                      </motion.div>
                    )}

                    {room.status === 'selection' && (
                      <motion.div key="selection" className="space-y-6">
                        {room.selectorId === user.uid ? (
                          <>
                            <div className="space-y-2">
                              <span className="text-xs font-bold uppercase tracking-widest text-orange-500">Your Turn</span>
                              <h3 className="text-3xl font-bold tracking-tight">Pick a Movie</h3>
                            </div>
                            <div className="relative">
                              <input 
                                type="text"
                                value={movieInput}
                                onChange={(e) => setMovieInput(e.target.value)}
                                placeholder="e.g. Inception"
                                className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-5 text-xl focus:outline-none focus:border-orange-500/50"
                              />
                              <button 
                                onClick={submitMovie}
                                disabled={actionLoading || !movieInput.trim()}
                                className="absolute right-2 top-2 bottom-2 px-6 bg-white text-black rounded-xl font-bold uppercase text-xs hover:bg-orange-500 hover:text-white disabled:opacity-50 transition-all"
                              >
                                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="text-center space-y-4">
                            <Loader2 className="w-8 h-8 text-orange-500 animate-spin mx-auto" />
                            <p className="text-gray-400">Waiting for {room.players[room.selectorId].name} to pick a movie...</p>
                          </div>
                        )}
                      </motion.div>
                    )}

                    {room.status === 'guessing' && (
                      <motion.div key="guessing" className="space-y-6">
                        <div className="space-y-1">
                          <p className="text-xs font-bold uppercase text-gray-500">Movie: <span className="text-white">{room.currentMovie}</span></p>
                          <h3 className="text-2xl font-bold">Which line is real?</h3>
                        </div>
                        <div className="grid gap-3">
                          {room.quotes?.map((q, i) => (
                            <button
                              key={i}
                              disabled={room.guesserId !== user.uid}
                              onClick={() => submitGuess(i)}
                              className="text-left p-5 rounded-2xl bg-white/5 border border-white/10 hover:border-white/30 hover:bg-white/10 transition-all active:scale-[0.98] disabled:opacity-50 disabled:hover:bg-white/5"
                            >
                              <p className="text-sm leading-relaxed">{q.text}</p>
                            </button>
                          ))}
                        </div>
                        {room.guesserId !== user.uid && (
                          <p className="text-center text-xs text-gray-500 animate-pulse">Waiting for {room.players[room.guesserId!].name} to guess...</p>
                        )}
                      </motion.div>
                    )}

                    {room.status === 'result' && room.lastResult && (
                      <motion.div key="result" className="text-center space-y-6">
                        <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto ${room.lastResult.correct ? 'bg-green-500' : 'bg-red-500'}`}>
                          {room.lastResult.correct ? <Trophy className="w-8 h-8" /> : <XCircle className="w-8 h-8" />}
                        </div>
                        <div className="space-y-2">
                          <h3 className="text-3xl font-black uppercase italic">
                            {room.lastResult.correct ? "Correct!" : "Fooled!"}
                          </h3>
                          <p className="text-gray-400 text-sm">
                            {room.lastResult.correct 
                              ? `${room.players[room.guesserId!].name} found the real line!` 
                              : `${room.players[room.guesserId!].name} fell for a fake!`}
                          </p>
                        </div>
                        <div className="bg-white/5 p-4 rounded-2xl border border-white/10 italic text-sm text-orange-400">
                          "{room.lastResult.realQuote}"
                        </div>
                        {room.selectorId === user.uid && (
                          <button 
                            onClick={nextRound}
                            className="w-full py-4 bg-white text-black rounded-2xl font-bold uppercase tracking-widest hover:bg-orange-500 hover:text-white transition-all"
                          >
                            Next Round
                          </button>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Room Footer */}
                <div className="mt-8 pt-4 border-t border-white/5 flex justify-between items-center">
                  <button 
                    onClick={() => {
                      if (confirm("Leave game?")) setRoom(null);
                    }}
                    className="text-[10px] font-bold uppercase text-gray-600 hover:text-red-500 transition-colors"
                  >
                    Leave Room
                  </button>
                  <span className="text-[10px] font-mono text-gray-700">CODE: {room.id}</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
