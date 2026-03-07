import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createMessages, getMessages } from "../actions";
import { MessageRole } from "@prisma/client";


export const prefetchMessages = async(queryClient , projectId)=>{
    await queryClient.prefetchQuery({
        queryKey:["messages" , projectId],
        queryFn:()=>getMessages(projectId),
        staleTime:10000
    })
}

export const useGetMessages = (projectId)=>{
    return useQuery({
        queryKey:["messages" , projectId],
        queryFn:()=>getMessages(projectId),
        staleTime:10000,
        refetchInterval:(query)=>{
            const messages = query.state.data;
            if(!Array.isArray(messages) || messages.length === 0){
                return false;
            }

            const lastMessage = messages[messages.length - 1];
            return lastMessage?.role === MessageRole.User ? 2000 : false;
        }
    })
}

export const useCreateMessages = (projectId)=>{
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn:(value)=>createMessages(value , projectId),
        onSuccess:()=>{
            queryClient.invalidateQueries({
                queryKey:["messages" , projectId]
            }),
            queryClient.invalidateQueries({
                queryKey:["status"]
            })
        }
    })
}
